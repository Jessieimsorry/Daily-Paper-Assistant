'use strict';
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpa-translation-'));
process.env.LITDESK_DATA_DIR = dir;
const store = require('../lib/store'); store.migrate();
require('../lib/discover').seedTopicsIfEmpty(); require('../lib/categories').seed();
const custom = require('../lib/customize'); custom.initialize();
const interpret = require('../lib/interpret'), multilingual = require('../lib/multilingual');
const original = interpret.callModel;
function paper(n) {
  store.run('INSERT INTO papers(title,abstract,language,dedup_key) VALUES(?,?,?,?)', ['Title '+n, 'Abstract '+n, 'en', 'queue-'+n]);
  return store.get('SELECT last_insert_rowid() id').id;
}
after(() => { interpret.callModel = original; store.db.close(); fs.rmSync(dir, {recursive:true, force:true}); });
test('cached translations bypass a saturated model queue; identical work is shared', async () => {
  interpret.callModel = async () => ({ok:true, content:'保存的译文', model:'fixture'});
  const cached = paper('cached');
  await multilingual.translate({subjectKey:'paper:'+cached, field:'title'});
  await new Promise(setImmediate);
  const gates=[];
  interpret.callModel = () => new Promise(resolve => gates.push(resolve));
  const jobs = Array.from({length:4}, (_,n) => multilingual.translate({subjectKey:'paper:'+paper(n), field:'title'}));
  assert.equal(gates.length, 4);
  const key = {subjectKey:'paper:'+paper('dedup'), field:'title'};
  const one = multilingual.translate(key), two = multilingual.translate(key);
  assert.equal(one, two);
  const hit = multilingual.translate({subjectKey:'paper:'+cached, field:'title'});
  try {
    const result = await Promise.race([hit, new Promise(resolve => setTimeout(() => resolve(null), 50))]);
    assert.ok(result?.cached, 'saved translation must not wait for any outstanding model response');
    assert.equal(result.translated, '保存的译文');
  } finally {
    interpret.callModel = async () => ({ok:true, content:'新译文', model:'fixture'});
    gates.forEach(resolve => resolve({ok:true, content:'新译文', model:'fixture'}));
    await Promise.all([...jobs,one,two,hit]);
  }
});
test('batch reports model failures instead of claiming translation succeeded', async () => {
  interpret.callModel = async () => ({ok:false, error:'fixture offline'});
  const id = paper('failure');
  const result = await multilingual.batch({paperIds:[id], fields:['title','abstract']});
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(x => x.field).sort(), ['abstract','title']);
  assert.equal(multilingual.saved('paper:'+id, 'title').text, null);
});
