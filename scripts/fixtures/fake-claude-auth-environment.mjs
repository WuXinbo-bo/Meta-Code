// Assert inside the launched process: checking the helper alone would miss an
// adapter that reintroduces inherited credentials after constructing its env.
import assert from 'node:assert/strict';
const auth = process.env.ANTHROPIC_AUTH_TOKEN;
const key = process.env.ANTHROPIC_API_KEY;
const url = process.env.ANTHROPIC_BASE_URL;
if (url === 'https://bearer.fixture.test') {
  assert.equal(auth, 'fixture-selected-token');
  assert.equal(key, undefined);
} else if (url === 'https://key.fixture.test') {
  assert.equal(key, 'fixture-selected-key');
  assert.equal(auth, undefined);
} else {
  assert.equal(url, undefined);
  assert.equal(key, undefined);
  assert.equal(auth, undefined);
}
const session = '550e8400-e29b-41d4-a716-446655440088';
process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:session})+'\n');
process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:session,result:'credentials-isolated',usage:{input_tokens:1,output_tokens:1}})+'\n');
