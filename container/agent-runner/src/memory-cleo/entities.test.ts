import { describe, expect, it } from 'bun:test';
import {
  titleToFilename, folderForType, relPathFor, parseNote, serializeNote, extractLinks,
} from './entities.js';

describe('entities', () => {
  it('kebab-cases titles into .md filenames', () => {
    expect(titleToFilename('Sara Ossandon')).toBe('sara-ossandon.md');
    expect(titleToFilename('Q2  Marketing!')).toBe('q2-marketing.md');
  });

  it('maps entity types to folders', () => {
    expect(folderForType('person')).toBe('people');
    expect(folderForType('project')).toBe('projects');
    expect(folderForType('meeting')).toBe('meetings');
  });

  it('builds a relative path for a typed entity', () => {
    expect(relPathFor('person', 'Sara Ossandon')).toBe('people/sara-ossandon.md');
  });

  it('extracts wikilinks', () => {
    expect(extractLinks('Works with [[Warehouse Lease]] and [[Tom]].')).toEqual(['Warehouse Lease', 'Tom']);
    expect(extractLinks('no links here')).toEqual([]);
  });

  it('serialize -> parse roundtrips title, body, links', () => {
    const note = { title: 'Sara Ossandon', type: 'person' as const, body: 'Architect at Studio Nord.', links: ['Warehouse Lease'] };
    const md = serializeNote(note);
    expect(md).toContain('# Sara Ossandon');
    expect(md).toContain('Architect at Studio Nord.');
    expect(md).toContain('[[Warehouse Lease]]');
    const parsed = parseNote('person', 'Sara Ossandon', md);
    expect(parsed.body).toContain('Architect at Studio Nord.');
    expect(parsed.links).toEqual(['Warehouse Lease']);
  });
});
