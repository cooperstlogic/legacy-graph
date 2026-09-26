
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { GraphEngine } from '../../src/core/GraphEngine';

// Helper to write a YAML file without an id (simulates dropping a user file)
async function writePersonNoId(filename: string, first: string, last: string, sex = 'M') {
    const content = `names:\n  - first: "${first}"\n    last: "${last}"\n    primary: true\nsex: "${sex}"\n`;
    await fs.writeFile(path.join(PEOPLE_DIR, filename), content);
}

const TEMP_DIR = path.join(__dirname, 'temp_hotpatch');
const PEOPLE_DIR = path.join(TEMP_DIR, 'people');
const STORIES_DIR = path.join(TEMP_DIR, 'stories');

// Helper to write a person file with optional parent type control
async function writePerson(filename: string, id: string, name: string, parentIds: string[] = [], parentType: string = 'biological') {
    const parents = parentIds.map(pid => ({ id: pid, type: parentType }));
    const content = `
version: "5.1"
id: "${id}"
created: "2023-01-01T00:00:00Z"
last_modified: "2023-01-01T00:00:00Z"
names:
  - first: "${name}"
    last: "Test"
sex: "M"
relationships:
  parents: ${JSON.stringify(parents)}
`;
    await fs.writeFile(path.join(PEOPLE_DIR, filename), content);
}

describe('GraphEngine Hot-Patching', () => {
    let engine: GraphEngine;

    beforeEach(async () => {
        await fs.mkdir(PEOPLE_DIR, { recursive: true });
        await fs.mkdir(STORIES_DIR, { recursive: true });
        engine = new GraphEngine(TEMP_DIR);
        await engine.hydrate();
    });

    afterEach(async () => {
        await engine.close(); // flush the debounced search-index write before deleting its dir
        await fs.rm(TEMP_DIR, { recursive: true, force: true });
    });

    it('should handle adding a new file via hot-patch', async () => {
        const filePath = path.join(PEOPLE_DIR, 'new_person.yaml');
        await writePerson('new_person.yaml', 'N_NEW', 'New');

        await (engine as any).handleFileUpdate(filePath);

        const graph = engine.getGraph();
        expect(graph.hasNode('N_NEW')).toBe(true);
        expect(graph.getNodeAttributes('N_NEW').data.names[0].first).toBe('New');
    });

    it('should handle modifying an existing file via hot-patch', async () => {
        const filePath = path.join(PEOPLE_DIR, 'existing.yaml');
        await writePerson('existing.yaml', 'N_EXIST', 'Original');
        await (engine as any).handleFileUpdate(filePath);

        expect(engine.getGraph().getNodeAttributes('N_EXIST').data.names[0].first).toBe('Original');

        await writePerson('existing.yaml', 'N_EXIST', 'Updated');
        await (engine as any).handleFileUpdate(filePath);

        expect(engine.getGraph().getNodeAttributes('N_EXIST').data.names[0].first).toBe('Updated');
    });

    it('should handle file deletion via hot-patch', async () => {
        const filePath = path.join(PEOPLE_DIR, 'delete_me.yaml');
        await writePerson('delete_me.yaml', 'N_DEL', 'DeleteMe');
        await (engine as any).handleFileUpdate(filePath);

        expect(engine.getGraph().hasNode('N_DEL')).toBe(true);

        await (engine as any).handleFileRemove(filePath);

        expect(engine.getGraph().hasNode('N_DEL')).toBe(false);
    });

    it('should auto-assign a human-readable ID to a dropped YAML file missing an id', async () => {
        const droppedPath = path.join(PEOPLE_DIR, 'jane.yaml');
        await writePersonNoId('jane.yaml', 'Jane', 'Austen');

        await (engine as any).handleFileUpdate(droppedPath);

        // A node with a human-readable N_ ID should appear in the graph
        const graph = engine.getGraph();
        const nodeIds = [...graph.nodeEntries()]
            .filter(({ attributes }) => attributes.type === 'person')
            .map(({ node }) => node);
        const janeNode = nodeIds.find(id => id.startsWith('N_jane'));
        expect(janeNode).toBeDefined();
        expect(graph.getNodeAttributes(janeNode!).data.names[0].first).toBe('Jane');
    });

    it('should write the generated id back into the YAML file', async () => {
        const droppedPath = path.join(PEOPLE_DIR, 'bach.yaml');
        await writePersonNoId('bach.yaml', 'Johann', 'Bach');

        await (engine as any).handleFileUpdate(droppedPath);

        // Find the renamed file (original path is gone, new N_* path exists)
        const files = await fs.readdir(PEOPLE_DIR);
        const renamedFile = files.find(f => f.startsWith('N_johann'));
        expect(renamedFile).toBeDefined();

        // The written YAML should contain the generated id
        const content = await fs.readFile(path.join(PEOPLE_DIR, renamedFile!), 'utf8');
        expect(content).toContain('id:');
        expect(content).toMatch(/id: N_/);
    });

    it('should rename the file to match the generated id', async () => {
        const droppedPath = path.join(PEOPLE_DIR, 'mozart.yaml');
        await writePersonNoId('mozart.yaml', 'Wolfgang', 'Mozart');

        await (engine as any).handleFileUpdate(droppedPath);

        // Original filename should be gone
        const files = await fs.readdir(PEOPLE_DIR);
        expect(files).not.toContain('mozart.yaml');

        // A file starting with N_wolfgang should exist
        const renamed = files.find(f => f.startsWith('N_wolfgang'));
        expect(renamed).toBeDefined();
        expect(renamed).toMatch(/\.yaml$/);
    });

    it('should update edges when parent reference changes', async () => {
        const sonPath = path.join(PEOPLE_DIR, 'son.yaml');
        const dadPath = path.join(PEOPLE_DIR, 'dad.yaml');

        await writePerson('dad.yaml', 'N_DAD', 'Dad');
        await writePerson('son.yaml', 'N_SON', 'Son', ['N_DAD']);

        await (engine as any).handleFileUpdate(dadPath);
        await (engine as any).handleFileUpdate(sonPath);

        const graph = engine.getGraph();
        expect(graph.hasEdge('N_SON', 'N_DAD')).toBe(true);

        await writePerson('son.yaml', 'N_SON', 'Son', []);
        await (engine as any).handleFileUpdate(sonPath);

        expect(graph.hasEdge('N_SON', 'N_DAD')).toBe(false);
    });
});

describe('Diff-Based Edge Reconciliation', () => {
    let engine: GraphEngine;

    beforeEach(async () => {
        await fs.mkdir(PEOPLE_DIR, { recursive: true });
        await fs.mkdir(STORIES_DIR, { recursive: true });
        engine = new GraphEngine(TEMP_DIR);
        await engine.hydrate();
    });

    afterEach(async () => {
        await engine.close(); // flush the debounced search-index write before deleting its dir
        await fs.rm(TEMP_DIR, { recursive: true, force: true });
    });

    it('should add exactly one edge when a new parent is added', async () => {
        // Setup: A exists with parent B
        await writePerson('b.yaml', 'N_B', 'ParentB');
        await writePerson('c.yaml', 'N_C', 'ParentC');
        await writePerson('a.yaml', 'N_A', 'Child', ['N_B']);

        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'b.yaml'));
        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'c.yaml'));
        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'a.yaml'));

        const graph = engine.getGraph();
        expect(graph.hasEdge('N_A', 'N_B')).toBe(true);
        expect(graph.hasEdge('N_A', 'N_C')).toBe(false);

        const edgesBefore = graph.outEdges('N_A').length;
        expect(edgesBefore).toBe(1);

        // Hot-patch: add C as second parent
        await writePerson('a.yaml', 'N_A', 'Child', ['N_B', 'N_C']);
        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'a.yaml'));

        // Verify: B edge preserved, C edge added, exactly 2 outgoing edges
        expect(graph.hasEdge('N_A', 'N_B')).toBe(true);
        expect(graph.hasEdge('N_A', 'N_C')).toBe(true);
        expect(graph.outEdges('N_A').length).toBe(2);
    });

    it('should remove exactly one edge when a parent is removed', async () => {
        // Setup: A has parents B and C
        await writePerson('b.yaml', 'N_B', 'ParentB');
        await writePerson('c.yaml', 'N_C', 'ParentC');
        await writePerson('a.yaml', 'N_A', 'Child', ['N_B', 'N_C']);

        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'b.yaml'));
        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'c.yaml'));
        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'a.yaml'));

        const graph = engine.getGraph();
        expect(graph.outEdges('N_A').length).toBe(2);

        // Hot-patch: remove B, keep C
        await writePerson('a.yaml', 'N_A', 'Child', ['N_C']);
        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'a.yaml'));

        // Verify: B edge gone, C edge preserved, exactly 1 outgoing edge
        expect(graph.hasEdge('N_A', 'N_B')).toBe(false);
        expect(graph.hasEdge('N_A', 'N_C')).toBe(true);
        expect(graph.outEdges('N_A').length).toBe(1);
    });

    it('should preserve incoming edges from other nodes during reconciliation', async () => {
        // Setup: A→B (child_of), D→A (child_of)
        await writePerson('b.yaml', 'N_B', 'GrandParent');
        await writePerson('c.yaml', 'N_C', 'NewParent');
        await writePerson('a.yaml', 'N_A', 'Parent', ['N_B']);
        await writePerson('d.yaml', 'N_D', 'GrandChild', ['N_A']);

        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'b.yaml'));
        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'c.yaml'));
        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'a.yaml'));
        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'd.yaml'));

        const graph = engine.getGraph();
        expect(graph.hasEdge('N_A', 'N_B')).toBe(true);
        expect(graph.hasEdge('N_D', 'N_A')).toBe(true);

        // Hot-patch: A changes parent from B to C
        await writePerson('a.yaml', 'N_A', 'Parent', ['N_C']);
        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'a.yaml'));

        // Verify: A→B gone, A→C added, D→A PRESERVED (incoming edge untouched)
        expect(graph.hasEdge('N_A', 'N_B')).toBe(false);
        expect(graph.hasEdge('N_A', 'N_C')).toBe(true);
        expect(graph.hasEdge('N_D', 'N_A')).toBe(true);
    });

    it('should update relationship type without dropping the edge', async () => {
        // Setup: A has biological parent B
        await writePerson('b.yaml', 'N_B', 'Parent');
        await writePerson('a.yaml', 'N_A', 'Child', ['N_B'], 'biological');

        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'b.yaml'));
        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'a.yaml'));

        const graph = engine.getGraph();
        const edgeBefore = graph.outEdges('N_A').find(e =>
            graph.getEdgeAttributes(e).type === 'child_of' && graph.target(e) === 'N_B'
        );
        expect(edgeBefore).toBeDefined();
        expect(graph.getEdgeAttributes(edgeBefore!).relType).toBe('biological');

        // Hot-patch: change type to adopted
        await writePerson('a.yaml', 'N_A', 'Child', ['N_B'], 'adopted');
        await (engine as any).handleFileUpdate(path.join(PEOPLE_DIR, 'a.yaml'));

        // Verify: edge still exists with updated type, no extra edges
        const edgeAfter = graph.outEdges('N_A').find(e =>
            graph.getEdgeAttributes(e).type === 'child_of' && graph.target(e) === 'N_B'
        );
        expect(edgeAfter).toBeDefined();
        expect(graph.getEdgeAttributes(edgeAfter!).relType).toBe('adopted');
        expect(graph.outEdges('N_A').length).toBe(1);
    });
});
