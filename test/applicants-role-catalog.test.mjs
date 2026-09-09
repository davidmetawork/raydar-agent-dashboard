import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../applicants.html', import.meta.url), 'utf8');
const catalogCode = html.slice(html.indexOf('function pagedRoleFilterOptions('),
  html.indexOf('function renderSortControl('));
const queryCode = html.slice(html.indexOf('function applicantPageView()'),
  html.indexOf('function applicantFiltersChanged('));
function ui(roles) {
  const select = { value: 'all', innerHTML: '' };
  const context = { STATE: { paged: true, role: 'all', view: 'review', chip: '',
    sort: 'newest', query: '' }, APPLICANT_PAGE: { manifest: { roles } }, URLSearchParams,
    $: () => select, esc: value => String(value), renderSortControl() {} };
  vm.createContext(context);
  vm.runInContext(catalogCode + '\n' + queryCode, context);
  return { context, select, options: context.pagedRoleFilterOptions(roles) };
}
const role = (sourceJobId, roleId, title = 'Engineer', company = 'Example') =>
  ({ sourceJobId, roleId, title, company });

test('an exact source job combines bound and unbound applicants without a role restriction', () => {
  const { context, select, options } = ui([
    role('workable:job:ONE', 'role-one'), role('workable:job:ONE', null),
  ]);
  assert.equal(options.size, 1);
  assert.equal(options.get('job:workable:job:ONE').roleId, undefined);
  context.STATE.role = 'job:workable:job:ONE';
  context.renderRoleFilter();
  assert.equal(select.value, 'job:workable:job:ONE');
  assert.equal((select.innerHTML.match(/Engineer @ Example/g) || []).length, 1);
  const query = context.applicantPageQuery();
  assert.equal(query.get('sourceJobId'), 'workable:job:ONE');
  assert.equal(query.has('roleId'), false);
});

test('equal labels never merge distinct source jobs or discard a shared role binding', () => {
  const { options } = ui([
    role('workable:job:ONE', 'shared-role'), role('workable:job:TWO', 'shared-role'),
    role('workable:job:ONE', null), role('workable:job:TWO', null),
  ]);
  assert.equal(options.size, 2);
  assert.deepEqual([...options.keys()], ['job:workable:job:ONE', 'job:workable:job:TWO']);
});

test('conflicting source labels remain explicit and exact job and role filters stay paired', () => {
  const { context, options } = ui([
    role('workable:job:ONE', 'role-one'), role('workable:job:ONE', null),
    role('workable:job:ONE', 'role-two', 'Engineering Lead'),
    role('workable:job:TWO', null), role('workable:job:TWO', null, 'Software Engineer'),
  ]);
  assert.equal(options.size, 5);
  for (const option of options.values()) assert.match(option.label, /conflicting source details/);
  const selected = [...options].find(([, option]) => option.roleId === 'role-two');
  context.STATE.role = selected[0];
  const query = context.applicantPageQuery();
  assert.equal(query.get('sourceJobId'), 'workable:job:ONE');
  assert.equal(query.get('roleId'), 'role-two');
  context.APPLICANT_PAGE.manifest.roles = [];
  assert.throws(() => context.applicantPageQuery(), /selected role details changed/);
});
