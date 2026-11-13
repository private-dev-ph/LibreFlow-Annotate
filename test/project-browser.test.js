const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepare } = require('../public/js/project-browser');
const projects = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, userId: i % 2 ? 'other' : 'me', ownerUsername: i % 2 ? 'Colleague' : 'Owner', name: `Project ${i + 1}`, description: i === 7 ? 'Find this board' : '', createdAt: new Date(2026, 0, i + 1).toISOString(), pinned: i === 22 || i === 25 }));
const images = projects.flatMap((p, i) => Array.from({ length: i % 4 }, (_, n) => ({ projectId: p.id, annotated: i % 4 === 3 || n === 1 })));
const view = options => prepare(projects, images, { userId: 'me', ...options });

test('all dashboard sorts are deterministic with pins first', () => {
  const unpinned = sort => view({ sort }).items.filter(p => !p.pinned);
  assert.equal(unpinned('newest')[0].id, 'p29');
  assert.equal(unpinned('oldest')[0].id, 'p0');
  assert.equal(unpinned('name-asc')[0].id, 'p0');
  assert.equal(unpinned('name-desc')[0].id, 'p29');
  for (const [sort, field] of [['progress','percent'],['images','total']]) {
    const rows = unpinned(sort);
    assert.ok(rows.every((p,i) => !i || rows[i-1]._stats[field] >= p._stats[field]));
  }
  for (const sort of ['newest','oldest','name-asc','name-desc','progress','images']) {
    assert.ok(view({ sort }).pageItems.slice(0,2).every(p => p.pinned));
    assert.deepEqual(view({ sort }), view({ sort }));
  }
});
test('grouping and pagination include each project once across page boundaries', () => {
  for (const group of ['none','progress','ownership']) {
    const pages=[1,2,3].map(page => view({ group, page }));
    const ids=pages.flatMap(v => v.pageItems.map(p => p.id));
    assert.equal(ids.length,30);assert.equal(new Set(ids).size,30);
    assert.deepEqual(pages.map(v => v.pageItems.length),[12,12,6]);
    assert.equal(pages[0].groups[0].label,'Pinned');
  }
  const groups = view({group:'progress',pageSize:48}).groups.map(g => g.label);
  assert.deepEqual(groups,['Pinned','Empty','Not started','In progress','Complete']);
  assert.deepEqual(view({group:'ownership',pageSize:48}).groups.map(g => g.label),['Pinned','My projects','Shared with me']);
});
test('search applies to pinned projects too and resets stale page bounds', () => {
  assert.equal(view({search:'  FIND THIS BOARD  '}).total,1);
  assert.equal(view({search:'colleague'}).total,15);
  assert.equal(view({search:'Project 23',page:9}).page,1);
  assert.equal(view({search:'Project 23'}).pageItems[0].pinned,true);
  const empty=view({search:'no such project',page:5});
  assert.equal(empty.total,0);assert.equal(empty.page,1);assert.equal(empty.start,0);assert.equal(empty.end,0);
  assert.equal(view({page:999}).page,3);
  assert.equal(view({pageSize:24}).pageItems.length,24);
  assert.equal(view({pageSize:48}).pageItems.length,30);
});
