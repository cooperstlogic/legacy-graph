import { describe, it, expect } from 'vitest';
import { GedcomReader } from '../../../src/core/gedcom/Import';

describe('GEDCOM Robustness', () => {
    const reader = new GedcomReader();

    describe('Date Parsing', () => {
        // We will expose the parseDate method publicly or test via a minimal person import
        // For unit testing private methods, we might need a public wrapper or just test the effect.
        // Let's test via full parse to ensure integration is correct.

        it('should parse standard DD MMM YYYY dates', async () => {
             const input = `
0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME John /Doe/
1 BIRT
2 DATE 10 JAN 1980
0 TRLR
`;
            const result = await reader.parse(input);
            expect(result.people[0].events[0].sort_date).toBe('1980-01-10');
        });

        it('should parse MMM YYYY dates', async () => {
             const input = `
0 HEAD
0 @I1@ INDI
1 NAME John /Doe/
1 BIRT
2 DATE FEB 1980
0 TRLR
`;
            const result = await reader.parse(input);
            expect(result.people[0].events[0].sort_date).toBe('1980-02-01');
        });

        it('should parse ABT (About) dates', async () => {
            const input = `
0 HEAD
0 @I1@ INDI
1 NAME John /Doe/
1 BIRT
2 DATE ABT 1850
0 TRLR
`;
            const result = await reader.parse(input);
            expect(result.people[0].events[0].sort_date).toBe('1850-01-01');
        });

        it('should parse ranges (BET/AND) into sort_date + sort_end_date', async () => {
            const input = `
0 HEAD
0 @I1@ INDI
1 NAME John /Doe/
1 BIRT
2 DATE BET 1900 AND 1910
0 TRLR
`;
            const result = await reader.parse(input);
            expect(result.people[0].events[0].sort_date).toBe('1900-01-01');
            expect(result.people[0].events[0].sort_end_date).toBe('1910-01-01');
            expect(result.people[0].events[0].end_date).toBe('1910');
        });
    });

    describe('Relationship Linking', () => {
        it('should link children to parents', async () => {
            const input = `
0 HEAD
0 @I1@ INDI
1 NAME Father /Doe/
1 SEX M
0 @I2@ INDI
1 NAME Mother /Doe/
1 SEX F
0 @I3@ INDI
1 NAME Child /Doe/
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
0 TRLR
`;
            const result = await reader.parse(input);
            const child = result.people.find(p => p.names[0].first === 'Child');
            expect(child).toBeDefined();
            
            // Should have 2 parents
            expect(child!.relationships.parents).toHaveLength(2);
            
            // Check IDs (we can't know the exact random IDs, but we can check existence)
            const father = result.people.find(p => p.names[0].first === 'Father');
            const mother = result.people.find(p => p.names[0].first === 'Mother');
            
            expect(child!.relationships.parents.map(r => r.id)).toContain(father!.id);
            expect(child!.relationships.parents.map(r => r.id)).toContain(mother!.id);
        });
    });

    describe('Line parsing', () => {
        it('should accept bare CR line terminators (allowed by the GEDCOM 5.5.1 grammar)', async () => {
            const input = ['0 HEAD', '0 @I1@ INDI', '1 NAME John /Doe/', '1 BIRT', '2 DATE 10 JAN 1980', '0 TRLR'].join('\r');
            const result = await reader.parse(input);
            expect(result.people).toHaveLength(1);
            expect(result.people[0].names[0].first).toBe('John');
            expect(result.people[0].events[0].sort_date).toBe('1980-01-10');
        });

        it('should keep a line value that contains a Unicode line separator', async () => {
            // `.` does not match U+2028, which used to make the line regex fail (after
            // quadratic backtracking over the whitespace run) and silently drop the line.
            const input = `
0 HEAD
0 @I1@ INDI
1 NAME John /Doe/
1 NOTE first part\u2028second part
0 TRLR
`;
            const result = await reader.parse(input);
            expect(result.people[0].scrapbook_md).toContain('first part\u2028second part');
        });
    });
});
