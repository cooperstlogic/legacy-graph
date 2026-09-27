import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';

type Sex = 'M' | 'F';

interface PersonRecord {
    version: '5.0';
    id: string;
    created: string;
    last_modified: string;
    names: Array<{
        primary: true;
        first: string;
        last: string;
        nickname?: string;
    }>;
    sex: 'M' | 'F' | 'I' | 'U';
    tags: string[];
    relationships: {
        parents: Array<{
            id: string;
            type: 'biological';
        }>;
    };
    events: Array<Record<string, unknown>>;
    assets: string[];
    scrapbook_md: string;
}

interface PersonNode {
    id: string;
    sex: Sex;
    first: string;
    last: string;
    generation: number;
    birthYear: number;
    parents: string[];
    spouseId: string | null;
    children: string[];
}

interface Args {
    count: number;
    generations: number;
    outputDir: string;
    seed: number;
    stories: number;
    cleanSynthetic: boolean;
}

const MALE_NAMES = [
    'James', 'William', 'Benjamin', 'Henry', 'Samuel', 'Thomas', 'George', 'Edward', 'Charles', 'Daniel',
    'Joseph', 'Arthur', 'Robert', 'Frank', 'Walter', 'David', 'John', 'Michael', 'Richard', 'Paul',
];

const FEMALE_NAMES = [
    'Mary', 'Anna', 'Emma', 'Elizabeth', 'Martha', 'Sarah', 'Clara', 'Alice', 'Grace', 'Helen',
    'Margaret', 'Rose', 'Evelyn', 'Florence', 'Lillian', 'Dorothy', 'Laura', 'Emily', 'Nora', 'Caroline',
];

const LAST_NAMES = [
    'Bennett', 'Carter', 'Hayes', 'Sullivan', 'Mercer', 'Bishop', 'Collins', 'Fletcher', 'Parker', 'Miller',
    'Reed', 'Campbell', 'Foster', 'Bryant', 'Ellis', 'Turner', 'Walsh', 'Pierce', 'Hawthorne', 'Donovan',
];

const TOWNS = [
    'Boston, Massachusetts, USA',
    'Providence, Rhode Island, USA',
    'Hartford, Connecticut, USA',
    'Albany, New York, USA',
    'Pittsburgh, Pennsylvania, USA',
    'Columbus, Ohio, USA',
    'Madison, Wisconsin, USA',
    'Richmond, Virginia, USA',
    'Nashville, Tennessee, USA',
    'Burlington, Vermont, USA',
];

class RNG {
    private state: number;

    constructor(seed: number) {
        this.state = seed >>> 0;
    }

    next(): number {
        // LCG constants from Numerical Recipes
        this.state = (1664525 * this.state + 1013904223) >>> 0;
        return this.state / 0x100000000;
    }

    int(min: number, max: number): number {
        return Math.floor(this.next() * (max - min + 1)) + min;
    }

    pick<T>(list: T[]): T {
        return list[this.int(0, list.length - 1)];
    }
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        count: 200,
        generations: 5,
        outputDir: './data',
        seed: 42,
        stories: 15,
        cleanSynthetic: true,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const current = argv[i];
        const next = argv[i + 1];

        if (current === '--count' && next) {
            args.count = parseInt(next, 10);
            i += 1;
        } else if (current === '--generations' && next) {
            args.generations = parseInt(next, 10);
            i += 1;
        } else if (current === '--output' && next) {
            args.outputDir = next;
            i += 1;
        } else if (current === '--seed' && next) {
            args.seed = parseInt(next, 10);
            i += 1;
        } else if (current === '--stories' && next) {
            args.stories = parseInt(next, 10);
            i += 1;
        } else if (current === '--keep-existing') {
            args.cleanSynthetic = false;
        } else if (current === '--help' || current === '-h') {
            printUsage();
            process.exit(0);
        }
    }

    if (!Number.isFinite(args.count) || args.count < 10) {
        throw new Error('--count must be a number >= 10');
    }
    if (!Number.isFinite(args.generations) || args.generations < 2) {
        throw new Error('--generations must be a number >= 2');
    }
    if (!Number.isFinite(args.seed)) {
        throw new Error('--seed must be a valid number');
    }
    if (!Number.isFinite(args.stories) || args.stories < 0) {
        throw new Error('--stories must be a number >= 0');
    }

    return args;
}

function printUsage(): void {
    console.log(`Synthetic data generator for LegacyGraph

Usage:
  npx tsx scripts/generateSyntheticData.ts [options]

Options:
  --count <n>         Total people to generate (default: 200)
  --generations <n>   Number of generations (default: 5)
  --stories <n>       Number of stories to generate (default: 15)
  --seed <n>          RNG seed for reproducible output (default: 42)
  --output <path>     Data directory root (default: ./data)
  --keep-existing     Do not remove existing synthetic files first
  --help, -h          Show this help
`);
}

function pad(num: number, size: number): string {
    return String(num).padStart(size, '0');
}

function isoDate(year: number, month: number, day: number): string {
    return `${year}-${pad(month, 2)}-${pad(day, 2)}`;
}

function splitCounts(total: number, buckets: number): number[] {
    const weights = Array.from({ length: buckets }, (_, i) => Math.pow(1.12, i));
    const sum = weights.reduce((acc, n) => acc + n, 0);
    const raw = weights.map((w) => (w / sum) * total);
    const counts = raw.map((n) => Math.floor(n));
    let remainder = total - counts.reduce((a, b) => a + b, 0);
    let idx = buckets - 1;
    while (remainder > 0) {
        counts[idx] += 1;
        remainder -= 1;
        idx = idx > 0 ? idx - 1 : buckets - 1;
    }
    return counts;
}

function makeId(index: number): string {
    return `N_SYN_${pad(index, 5)}`;
}

function chooseFirstName(sex: Sex, rng: RNG): string {
    return sex === 'M' ? rng.pick(MALE_NAMES) : rng.pick(FEMALE_NAMES);
}

function chooseLastName(rng: RNG): string {
    return rng.pick(LAST_NAMES);
}

function dateFromYear(year: number, rng: RNG): { date: string; sortDate: string } {
    const month = rng.int(1, 12);
    const day = rng.int(1, 28);
    return {
        date: `${day} ${new Date(Date.UTC(2000, month - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()} ${year}`,
        sortDate: isoDate(year, month, day),
    };
}

function buildPeople(args: Args, rng: RNG): PersonNode[] {
    const generationCounts = splitCounts(args.count, args.generations);
    const nodes: PersonNode[] = [];
    const byGeneration: PersonNode[][] = Array.from({ length: args.generations }, () => []);
    const couplesByGeneration: Array<Array<[PersonNode, PersonNode]>> = Array.from({ length: args.generations }, () => []);

    let personCounter = 1;
    const oldestBaseYear = 1925;
    const yearsPerGeneration = 27;

    for (let gen = 0; gen < args.generations; gen += 1) {
        const countForGen = generationCounts[gen];
        const targetBirthYear = oldestBaseYear + gen * yearsPerGeneration;

        for (let i = 0; i < countForGen; i += 1) {
            const sex: Sex = rng.next() < 0.5 ? 'M' : 'F';
            const node: PersonNode = {
                id: makeId(personCounter),
                sex,
                first: chooseFirstName(sex, rng),
                last: chooseLastName(rng),
                generation: gen,
                birthYear: targetBirthYear + rng.int(-4, 4),
                parents: [],
                spouseId: null,
                children: [],
            };
            personCounter += 1;
            nodes.push(node);
            byGeneration[gen].push(node);
        }
    }

    for (let gen = 0; gen < args.generations; gen += 1) {
        const males = byGeneration[gen].filter((p) => p.sex === 'M');
        const females = byGeneration[gen].filter((p) => p.sex === 'F');
        const pairCount = Math.min(males.length, females.length);
        for (let i = 0; i < pairCount; i += 1) {
            const male = males[i];
            const female = females[i];
            male.spouseId = female.id;
            female.spouseId = male.id;
            couplesByGeneration[gen].push([male, female]);
        }
    }

    for (let gen = 1; gen < args.generations; gen += 1) {
        const parentCouples = couplesByGeneration[gen - 1];
        const prevGeneration = byGeneration[gen - 1];
        if (parentCouples.length === 0 || prevGeneration.length < 2) {
            continue;
        }

        for (const child of byGeneration[gen]) {
            const [father, mother] = rng.pick(parentCouples);
            child.parents = [father.id, mother.id];
            child.last = father.last;

            father.children.push(child.id);
            mother.children.push(child.id);
        }
    }

    return nodes;
}

function toPersonYaml(node: PersonNode, rng: RNG): PersonRecord {
    const birth = dateFromYear(node.birthYear, rng);
    const tags = [`synthetic`, `generation-${node.generation + 1}`];
    if (node.children.length > 0) tags.push('parent');

    const events: Array<Record<string, unknown>> = [
        {
            id: `evt_birth_${node.id}`,
            type: 'birth',
            date: birth.date,
            sort_date: birth.sortDate,
            location: rng.pick(TOWNS),
            description: 'Synthetic generated birth record',
            assets: [],
        },
    ];

    if (node.spouseId) {
        const marriageYear = node.birthYear + rng.int(21, 33);
        const marriageDate = dateFromYear(marriageYear, rng);
        events.push({
            id: `evt_marriage_${node.id}`,
            type: 'marriage',
            date: marriageDate.date,
            sort_date: marriageDate.sortDate,
            partner_id: node.spouseId,
            status: 'married',
            location: rng.pick(TOWNS),
            assets: [],
        });
    }

    if (2026 - node.birthYear > 22) {
        const occupationYear = node.birthYear + rng.int(22, 30);
        const occupationDate = dateFromYear(occupationYear, rng);
        events.push({
            id: `evt_work_${node.id}`,
            type: 'occupation',
            title: rng.pick(['Teacher', 'Carpenter', 'Nurse', 'Engineer', 'Bookkeeper', 'Farmer', 'Clerk']),
            organization: rng.pick(['City Office', 'County Hospital', 'Rail Depot', 'Public School', 'Family Shop']),
            date: occupationDate.date,
            sort_date: occupationDate.sortDate,
            location: rng.pick(TOWNS),
            assets: [],
        });
    }

    if (2026 - node.birthYear > 75 && rng.next() < 0.55) {
        const deathYear = Math.min(2024, node.birthYear + rng.int(72, 94));
        const deathDate = dateFromYear(deathYear, rng);
        events.push({
            id: `evt_death_${node.id}`,
            type: 'death',
            date: deathDate.date,
            sort_date: deathDate.sortDate,
            location: rng.pick(TOWNS),
            cause: rng.pick(['Natural causes', 'Heart disease', 'Pneumonia', 'Stroke']),
            assets: [],
        });
    }

    const timestamp = new Date(Date.UTC(2026, rng.int(0, 1), rng.int(1, 28), rng.int(0, 23), rng.int(0, 59), 0)).toISOString();
    return {
        version: '5.0',
        id: node.id,
        created: timestamp,
        last_modified: timestamp,
        names: [
            {
                primary: true,
                first: node.first,
                last: node.last,
            },
        ],
        sex: node.sex,
        tags,
        relationships: {
            parents: node.parents.map((parentId) => ({
                id: parentId,
                type: 'biological',
            })),
        },
        events,
        assets: [],
        scrapbook_md: `Synthetic profile generated with seed data for ${node.first} ${node.last}.`,
    };
}

async function cleanOldSyntheticFiles(peopleDir: string, storiesDir: string): Promise<void> {
    const people = await fs.readdir(peopleDir).catch(() => []);
    const stories = await fs.readdir(storiesDir).catch(() => []);

    await Promise.all(
        people
            .filter((file) => file.startsWith('N_SYN_') && file.endsWith('.yaml'))
            .map((file) => fs.unlink(path.join(peopleDir, file)))
    );

    await Promise.all(
        stories
            .filter((file) => file.startsWith('synthetic-family-') && file.endsWith('.md'))
            .map((file) => fs.unlink(path.join(storiesDir, file)))
    );
}

function storyBody(index: number, family: PersonNode[], rng: RNG): string {
    const references = family.map((p) => `@${p.id}`).join(', ');
    const place = rng.pick(TOWNS);
    return `---
title: "Synthetic Family Story ${index}"
date: "${isoDate(rng.int(1980, 2024), rng.int(1, 12), rng.int(1, 28))}"
tags:
  - synthetic
  - family-history
assets: []
---

${references} gathered in ${place} for a multi-generation family event.

This story is synthetic test content for search, mentions, and timeline views.
`;
}

async function writeStories(storiesDir: string, people: PersonNode[], count: number, rng: RNG): Promise<number> {
    if (count <= 0 || people.length < 4) return 0;
    let created = 0;

    for (let i = 1; i <= count; i += 1) {
        const sample: PersonNode[] = [];
        for (let j = 0; j < 4; j += 1) {
            sample.push(people[rng.int(0, people.length - 1)]);
        }
        const content = storyBody(i, sample, rng);
        const filePath = path.join(storiesDir, `synthetic-family-${pad(i, 3)}.md`);
        await fs.writeFile(filePath, content, 'utf8');
        created += 1;
    }

    return created;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const rng = new RNG(args.seed);

    const outputDir = path.resolve(args.outputDir);
    const peopleDir = path.join(outputDir, 'people');
    const storiesDir = path.join(outputDir, 'stories');
    const assetsDir = path.join(outputDir, 'assets');
    const metaDir = path.join(outputDir, '_meta');

    await fs.mkdir(peopleDir, { recursive: true });
    await fs.mkdir(storiesDir, { recursive: true });
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.mkdir(metaDir, { recursive: true });

    if (args.cleanSynthetic) {
        await cleanOldSyntheticFiles(peopleDir, storiesDir);
    }

    const peopleNodes = buildPeople(args, rng);
    const personRecords = peopleNodes.map((node) => toPersonYaml(node, rng));

    for (const person of personRecords) {
        const personPath = path.join(peopleDir, `${person.id}.yaml`);
        await fs.writeFile(personPath, yaml.dump(person, { noRefs: true, lineWidth: 120 }), 'utf8');
    }

    const storyCount = await writeStories(storiesDir, peopleNodes, args.stories, rng);

    const withParents = peopleNodes.filter((p) => p.parents.length === 2).length;
    console.log(`[SyntheticData] Output directory: ${outputDir}`);
    console.log(`[SyntheticData] Wrote ${personRecords.length} people records.`);
    console.log(`[SyntheticData] ${withParents} people include realistic 2-parent links.`);
    console.log(`[SyntheticData] Wrote ${storyCount} story files.`);
    console.log('[SyntheticData] Done.');
}

main().catch((err) => {
    console.error('[SyntheticData] Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
