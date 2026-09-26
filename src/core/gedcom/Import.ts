import { Person } from '../../schemas/PersonSchema';
import type { Place } from '../../schemas/PlaceSchema';
import * as crypto from 'crypto';
import { parseDateRange } from '../../utils/dateParser';
import { generatePersonId } from '../../utils/idGenerator';

/** Convert a GEDCOM PLAC string to a Place object, or undefined if empty. */
function placeFromString(s: string): Place | undefined {
    return s ? { name: s } : undefined;
}

/** Build the date fields for an event from a single GEDCOM DATE string.
 *  Ranges (BET … AND …, FROM … TO …) populate end_date + sort_end_date;
 *  single points omit them entirely. */
function dateFields(raw: string): {
    date: string;
    sort_date: string | null;
    end_date?: string;
    sort_end_date?: string;
} {
    const { sort_date, sort_end_date } = parseDateRange(raw);
    if (!sort_end_date) return { date: raw, sort_date };
    const m = raw.match(/^(?:BET\s+.+?\s+AND|FROM\s+.+?\s+TO)\s+(.+)$/i);
    return {
        date: raw,
        sort_date,
        sort_end_date,
        ...(m?.[1]?.trim() ? { end_date: m[1].trim() } : {}),
    };
}

// --- Custom GEDCOM Parser Types ---

interface GedcomLine {
    level: number;
    tag: string; // e.g. INDI, BIRT, DATE
    value?: string; // e.g. "10 JAN 1980" or "@I1@" if pointer is in value position? 
                   // Actually standard is: Level [Optional Xref] Tag [Optional LineValue]
    xref_id?: string; // The pointer @I1@ defined at start of line
}

interface GedcomNode {
    tag: string;
    value?: string;
    xref_id?: string;
    children: GedcomNode[];
}

export interface ImportResult {
    people: Person[];
    warnings: string[];
}

export class GedcomReader {
    
    /**
     * Parses a GEDCOM string (or buffer) into an in-memory graph of Person objects.
     */
    public async parse(input: string | Buffer): Promise<ImportResult> {
        const raw = input.toString();
        // GEDCOM terminators: CR, LF, CRLF or LFCR (the last yields an empty line, skipped below)
        const lines = raw.split(/\r\n|\r|\n/);
        
        const roots: GedcomNode[] = [];
        const stack: { node: GedcomNode, level: number }[] = [];

        // 1. Build CST (Tree)
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const parsed = this.parseLine(line);
            if (!parsed) continue;

            const node: GedcomNode = {
                tag: parsed.tag,
                value: parsed.value,
                xref_id: parsed.xref_id,
                children: []
            };

            if (parsed.level === 0) {
                roots.push(node);
                stack.length = 0; // Reset stack
                stack.push({ node, level: 0 });
            } else {
                // Find parent (first item in stack with level < current level)
                // Actually, standard is parent level = current - 1
                while (stack.length > 0 && stack[stack.length - 1].level >= parsed.level) {
                   stack.pop();
                }
                
                if (stack.length > 0) {
                    const parent = stack[stack.length - 1].node;
                    parent.children.push(node);
                    stack.push({ node, level: parsed.level });
                } else {
                    // Orphan node (shouldn't happen in valid GEDCOM)
                    // We ignore or treat as root? Treat as root for robustness.
                    roots.push(node);
                    stack.push({ node, level: parsed.level });
                }
            }
        }

        // 2. Process Tree
        return this.processTree(roots);
    }

    private parseLine(line: string): GedcomLine | null {
        // Format: Level [Optional Xref] Tag [Optional LineValue]
        // Regex: ^(\d+)\s+(@\w+@)?\s*(\w+)(\s+(.*))?$
        // Note: Xref IDs can contain anything, usually alphanum. Tag is alphanum.
        
        // [\s\S]* (not .*) so the value can never fail to match: with .*, a character
        // it skips (e.g. U+2028) forced quadratic backtracking and dropped the line.
        const match = line.match(/^(\d+)\s+(?:(@[^@]+@)\s+)?(\w+)(?:\s+([\s\S]*))?$/);
        if (!match) return null;

        return {
            level: parseInt(match[1], 10),
            xref_id: match[2],     // @I1@
            tag: match[3],         // INDI
            value: match[4]        // Rest of line
        };
    }

    private processTree(roots: GedcomNode[]): ImportResult {
        const people: Person[] = [];
        const warnings: string[] = [];
        const idMap = new Map<string, string>(); // @I1@ -> N_...

        // Pass 1: INDI records -> Persons
        roots.filter(n => n.tag === 'INDI').forEach(node => {
            if (!node.xref_id) return;

            const p: Person = {
                version: "5.1",
                id: '', // filled after mapIndi so we have name + events
                created: new Date().toISOString(),
                last_modified: new Date().toISOString(),
                names: [],
                events: [],
                assets: [],
                relationships: { parents: [] },
                sex: "U",
                tags: ["gedcom"],
                scrapbook_md: "",
                _gedcom: {}
            };

            this.mapIndi(node, p);

            const newId = generatePersonId(p);
            p.id = newId;
            idMap.set(node.xref_id, newId);
            people.push(p);
        });

        // Pass 2: FAM records -> Marriages and Parent-Child Links
        roots.filter(n => n.tag === 'FAM').forEach(node => {
            const husbRef = this.getChildValue(node, 'HUSB'); // @I1@
            const wifeRef = this.getChildValue(node, 'WIFE'); // @I2@
            
            const fatherId = husbRef ? idMap.get(husbRef) : undefined;
            const motherId = wifeRef ? idMap.get(wifeRef) : undefined;

            // 2a. Marriage Event — create even when no MARR record exists (use empty date)
            const marrNode = node.children.find(c => c.tag === 'MARR');
            if (fatherId && motherId) {
                const rawDate = marrNode ? (this.getChildValue(marrNode, 'DATE') || "") : "";
                const place = marrNode ? (this.getChildValue(marrNode, 'PLAC') || "") : "";
                const addr = marrNode ? (this.getChildValue(marrNode, 'ADDR') || "") : "";
                const dates = dateFields(rawDate);

                // Add to Husband
                const h = people.find(x => x.id === fatherId);
                if (h) {
                    h.events.push({
                        id: crypto.randomUUID(), type: 'marriage', ...dates,
                        location: placeFromString(place), assets: [],
                        partner_id: motherId, status: 'married',
                        ...(addr ? { site_name: addr } : {})
                    });
                }

                // Add to Wife
                const w = people.find(x => x.id === motherId);
                if (w) {
                    w.events.push({
                        id: crypto.randomUUID(), type: 'marriage', ...dates,
                        location: placeFromString(place), assets: [],
                        partner_id: fatherId, status: 'married',
                        ...(addr ? { site_name: addr } : {})
                    });
                }
            }

            // 2a2. Divorce Event
            const divNode = node.children.find(c => c.tag === 'DIV');
            if (divNode && fatherId && motherId) {
                const rawDate = this.getChildValue(divNode, 'DATE') || "";
                const place = this.getChildValue(divNode, 'PLAC') || "";
                const addr = this.getChildValue(divNode, 'ADDR') || "";
                const dates = dateFields(rawDate);

                const h = people.find(x => x.id === fatherId);
                if (h) {
                    h.events.push({
                        id: crypto.randomUUID(), type: 'divorce', ...dates,
                        location: placeFromString(place), assets: [], partner_id: motherId,
                        ...(addr ? { site_name: addr } : {})
                    });
                }

                const w = people.find(x => x.id === motherId);
                if (w) {
                    w.events.push({
                        id: crypto.randomUUID(), type: 'divorce', ...dates,
                        location: placeFromString(place), assets: [], partner_id: fatherId,
                        ...(addr ? { site_name: addr } : {})
                    });
                }
            }

            // 2b. Parent-Child Relationships (The new robust logic)
            // Iterate all CHIL tags
            node.children.filter(c => c.tag === 'CHIL').forEach(childNode => {
                 const childRef = childNode.value;
                 const childId = childRef ? idMap.get(childRef) : undefined;
                 
                 if (childId) {
                     const child = people.find(p => p.id === childId);
                     if (child) {
                         if (fatherId) {
                             child.relationships.parents.push({ id: fatherId, type: 'biological' });
                         }
                         if (motherId) {
                             child.relationships.parents.push({ id: motherId, type: 'biological' });
                         }
                     }
                 }
            });
        });

        return { people, warnings };
    }

    private mapIndi(node: GedcomNode, p: Person) {
        // Name — "John /Doe/" or "John /Doe/ Jr."
        const nameVal = this.getChildValue(node, 'NAME');
        if (nameVal) {
             const parts = nameVal.split('/').map(s => s.trim());
             p.names.push({
                 first: parts[0] || "Unknown",
                 last: parts[1] || "",
                 primary: true
             });
        } else {
            // Fallback: INDI with no NAME tag still needs a valid names array
            p.names.push({ first: "Unknown", last: "", primary: true });
        }

        // Sex
        const sex = this.getChildValue(node, 'SEX');
        if (sex === 'M') p.sex = 'M';
        if (sex === 'F') p.sex = 'F';

        // Simple event tags: GEDCOM tag -> LegacyGraph event type
        const simpleEventTags: Record<string, string> = {
            'BIRT': 'birth', 'DEAT': 'death', 'CHR': 'baptism', 'BURI': 'burial',
            'RESI': 'residence', 'EMIG': 'emigration', 'IMMI': 'immigration', 'ADOP': 'adoption'
        };

        const ignoredTags = new Set(['NAME', 'SEX', 'FAMC', 'FAMS', 'SOUR', 'OBJE', 'CHAN', 'SUBM']);

        node.children.forEach(child => {
            if (simpleEventTags[child.tag]) {
                const rawDate = this.getChildValue(child, 'DATE') || "";
                const place = this.getChildValue(child, 'PLAC') || "";
                const addr = this.getChildValue(child, 'ADDR') || "";
                p.events.push({
                    id: crypto.randomUUID(),
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- discriminated union type from runtime GEDCOM tag map
                    type: simpleEventTags[child.tag] as any,
                    ...dateFields(rawDate),
                    location: placeFromString(place),
                    assets: [],
                    ...(addr ? { site_name: addr } : {})
                });
            } else if (child.tag === 'OCCU') {
                // Occupation: value is the job title
                const title = child.value || this.getChildValue(child, 'TYPE') || "Unknown";
                const rawDate = this.getChildValue(child, 'DATE') || "";
                const place = this.getChildValue(child, 'PLAC') || "";
                const addr = this.getChildValue(child, 'ADDR') || "";
                p.events.push({
                    id: crypto.randomUUID(),
                    type: 'occupation',
                    title,
                    ...dateFields(rawDate),
                    location: placeFromString(place),
                    assets: [],
                    ...(addr ? { site_name: addr } : {})
                });
            } else if (child.tag === 'EVEN') {
                // Generic event: TYPE subtag gives the title
                const title = this.getChildValue(child, 'TYPE') || child.value || "";
                const rawDate = this.getChildValue(child, 'DATE') || "";
                const place = this.getChildValue(child, 'PLAC') || "";
                const addr = this.getChildValue(child, 'ADDR') || "";
                p.events.push({
                    id: crypto.randomUUID(),
                    type: 'generic',
                    title,
                    ...dateFields(rawDate),
                    location: placeFromString(place),
                    assets: [],
                    ...(addr ? { site_name: addr } : {})
                });
            } else if (child.tag === 'NOTE') {
                // Assemble NOTE text including CONT (newline) and CONC (concatenate) children
                let noteText = child.value || "";
                child.children.forEach(nc => {
                    if (nc.tag === 'CONT') noteText += "\n" + (nc.value || "");
                    else if (nc.tag === 'CONC') noteText += (nc.value || "");
                });
                if (noteText) {
                    p.scrapbook_md += (p.scrapbook_md ? "\n\n" : "") + noteText;
                }
            } else if (!ignoredTags.has(child.tag)) {
                // Capture unrecognised attributes in the loss-prevention bucket
                if (p._gedcom) {
                    p._gedcom[child.tag] = child.value;
                }
            }
        });
    }

    private getChildValue(node: GedcomNode, tag: string): string | undefined {
        const child = node.children.find(c => c.tag === tag);
        return child ? child.value : undefined;
    }

    // parseDate removed in favor of shared utility
}
