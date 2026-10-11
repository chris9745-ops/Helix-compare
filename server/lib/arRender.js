/**
 * Turns the helper's JSON for an Active Link / Filter / Escalation into something a person can
 * read in the browser: a "Run If" string, decoded execute-on, and one summary per action.
 *
 * Pure functions, no I/O. Field names come from a `fields(form, id) -> name|null` callback so
 * the caller decides how (and whether) to resolve them; unresolved ids render as `#<id>`.
 *
 * Input shapes are what workflow-helper/ar-helper.js emits:
 *   qualifier  {op:'and'|'or', l, r} | {op:'not', x} | {op:'rel', rel, l, r} | {op:'fromField'} | null
 *   operand    {t: 1|2|3|5|50|51|52|99..., v}      value  {dt, v}
 */
const { KEYWORDS, FILTER_OPS, EXECUTE_ON, FUNCTIONS, DISPLAY_PROPS } = require('./arConstants');

const REL_OPS = { 1: '=', 2: '>', 3: '>=', 4: '<', 5: '<=', 6: '!=', 7: 'LIKE', 8: 'IN', 9: 'NOT IN', 10: 'EXISTS' };
const ARITH_OPS = { 1: '+', 2: '-', 3: '*', 4: '/', 5: '%' };
const MESSAGE_TYPES = { 0: 'Note', 1: 'Warning', 2: 'Error', 3: 'Fatal', 5: 'Prompt', 6: 'Accessible', 7: 'Tooltip' };
const WINDOW_MODES = {
  0: 'Dialog', 1: 'Search', 2: 'Submit', 3: 'Modify (list)', 4: 'Modify (detail)', 5: 'Modify (split)',
  6: 'Display (list)', 7: 'Display (detail)', 8: 'Display (split)', 9: 'Report', 10: 'Modify', 11: 'Display',
  12: 'Modify (direct)', 16: 'Display (direct)', 20: 'Popup'
};
const GOTO_TAGS = { 1: 'order stored in field', 2: 'execution order', 3: 'skip forward', 4: 'skip back' };
const CORE_FIELDS = {
  1: 'Request ID', 2: 'Submitter', 3: 'Create Date', 4: 'Assigned To', 5: 'Last Modified By',
  6: 'Last Modified Date', 7: 'Status', 8: 'Short Description', 15: 'Status History'
};
// UI labels for the execute-on bits (anything not listed falls back to a Title Case of the API name)
const EXECUTE_ON_LABELS = {
  BUTTON: 'Button/Menu Item', RETURN: 'Return', SUBMIT: 'Submit', MODIFY: 'Modify', DISPLAY: 'Display',
  MODIFY_ALL: 'Modify All', MENU_OPEN: 'Menu Open', MENU_CHOICE: 'Menu Choice', LOSE_FOCUS: 'Lose Focus',
  SET_DEFAULT: 'Set Default', QUERY: 'Search', AFTER_MODIFY: 'After Modify', AFTER_SUBMIT: 'After Submit',
  GAIN_FOCUS: 'Gain Focus', WINDOW_OPEN: 'Window Open', WINDOW_CLOSE: 'Window Close', UNDISPLAY: 'Un-Display',
  COPY_SUBMIT: 'Copy To New', LOADED: 'Window Loaded', INTERVAL: 'Interval', EVENT: 'Event',
  TABLE_CONTENT_CHANGE: 'Table Refresh'
};
const FILTER_OP_LABELS = { GET: 'Get Entry', SET: 'Modify', CREATE: 'Submit', DELETE: 'Delete', MERGE: 'Merge', GUIDE: 'Guide', SERVICE: 'Service' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const titleCase = (s) => String(s).toLowerCase().replace(/(^|_)([a-z])/g, (_, a, c) => (a ? ' ' : '') + c.toUpperCase());
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const clip = (s, n = 400) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

/** `ctx` = { primaryForm, fields(form, id) } — plus per-call { otherForm, topLevel }. */
function fieldName(ctx, form, id) {
  const resolved = ctx.fields && form ? ctx.fields(form, id) : null;
  if (resolved) return resolved;
  return CORE_FIELDS[id] ? `${CORE_FIELDS[id]}` : `#${id}`;
}

function renderValue(v) {
  if (!v || v.dt === 0 || v.v === null || v.v === undefined) return '$NULL$';
  switch (v.dt) {
    case 1: return `$${KEYWORDS[v.v] || v.v}$`;
    case 4: case 5: return quote(v.v);
    case 7: return isNum(v.v) ? `Timestamp(${new Date(v.v * 1000).toISOString()})` : String(v.v);
    case 2: case 3: case 6: case 8: case 10: return String(v.v);
    default:
      return typeof v.v === 'object' ? clip(JSON.stringify(v.v)) : String(v.v);
  }
}

function renderOperand(o, ctx, scope) {
  if (!o) return '$NULL$';
  const primary = ctx.primaryForm;
  switch (o.t) {
    case 1: return `'${fieldName(ctx, scope.topLevel ? primary : scope.otherForm || primary, o.v)}'`;
    case 99: return scope.topLevel ? `'${fieldName(ctx, primary, o.v)}'` : `$${fieldName(ctx, primary, o.v)}$`;
    case 50: return `'TR.${fieldName(ctx, primary, o.v)}'`;
    case 51: return `'DB.${fieldName(ctx, primary, o.v)}'`;
    case 52: return `$LOCAL.${o.v}$`;
    case 2: return renderValue(o.v);
    case 3: {
      const a = o.v || {};
      const l = renderOperand(a.leftOperand, ctx, scope), r = renderOperand(a.rightOperand, ctx, scope);
      return a.operation === 6 ? `-${l}` : `(${l} ${ARITH_OPS[a.operation] || '?'} ${r})`;
    }
    case 5: return `(${(Array.isArray(o.v) ? o.v : []).map(renderValue).join(', ')})`;
    default: return `<operand type ${o.t}: ${clip(JSON.stringify(o.v), 120)}>`;
  }
}

/**
 * scope: { topLevel: bool, otherForm }.  topLevel = a Run-If / escalation qualification, where every
 * field belongs to the object's own form.  Inside actions, type-1 fields belong to `otherForm`
 * and type-99 fields are read from the current transaction.
 */
function renderQualifier(q, ctx, scope = { topLevel: true }, parentOp = null) {
  if (!q) return '';
  switch (q.op) {
    case 'and': case 'or': {
      const text = `${renderQualifier(q.l, ctx, scope, q.op)} ${q.op.toUpperCase()} ${renderQualifier(q.r, ctx, scope, q.op)}`;
      return parentOp && parentOp !== q.op ? `(${text})` : text;
    }
    case 'not': return `NOT (${renderQualifier(q.x, ctx, scope, 'not')})`;
    case 'rel': {
      const op = REL_OPS[q.rel] || `op${q.rel}`;
      return `${renderOperand(q.l, ctx, scope)} ${op} ${renderOperand(q.r, ctx, scope)}`;
    }
    case 'fromField': return '<qualification from field>';
    default: return '';
  }
}

function renderAssignField(f, ctx) {
  if (!f) return '<field>';
  const here = !f.form || f.form === '@' || f.form === '*'; // '*' = the current screen
  if (here) return `$${fieldName(ctx, ctx.primaryForm, f.fieldId)}$`;
  let s = `'${f.form}'.'${fieldName(ctx, f.form, f.fieldId)}'`;
  if (f.qualifier) s += ` WHERE ${renderQualifier(f.qualifier, ctx, { topLevel: false, otherForm: f.form })}`;
  return s;
}

function renderAssign(a, ctx) {
  if (!a) return '';
  switch (a.assignType) {
    case 1: return renderValue(a.value);
    case 2: return renderAssignField(a.field, ctx);
    case 3: return `$PROCESS$ ${a.process}`;
    case 4: {
      const ar = a.arithOp || {};
      const l = renderAssign(ar.operandLeft, ctx), r = renderAssign(ar.operandRight, ctx);
      return ar.operation === 6 ? `-${l}` : `(${l} ${ARITH_OPS[ar.operation] || '?'} ${r})`;
    }
    case 5: {
      const fn = a.function || {};
      const name = FUNCTIONS[fn.functionCode] || `FUNCTION_${fn.functionCode}`;
      return `${name}(${(fn.parameterList || []).map((p) => renderAssign(p, ctx)).join(', ')})`;
    }
    case 7: return `SQL: ${clip((a.sql || {}).sqlCommand || '', 300)}`;
    case 6: return `DDE: ${clip(JSON.stringify(a.dde), 200)}`;
    case 8: return `FILTER API: ${clip(JSON.stringify(a.filterApi), 200)}`;
    default: return '';
  }
}

const assignOf = (item) => item.assignment || item.assign || null;

/** `'Target' = <assignment>` lines for a FieldAssignInfo list (target fields live on `targetForm`). */
function assignmentLines(list, ctx, targetForm) {
  return (list || []).map((item) => {
    const targetId = item.fieldId !== undefined ? item.fieldId : item.field && item.field.fieldId;
    return `'${fieldName(ctx, targetForm, targetId)}' = ${renderAssign(assignOf(item), ctx)}`;
  });
}

function matchOptions(a) {
  const bits = [];
  if (isNum(a.noMatchOption)) bits.push(`no match: ${['', 'error', 'set null', 'no action', 'set null', 'continue'][a.noMatchOption] || a.noMatchOption}`);
  if (isNum(a.multiMatchOption)) bits.push(`multiple: ${['', 'error', 'first', 'picklist', 'modify all', 'no action', 'use set fields'][a.multiMatchOption] || a.multiMatchOption}`);
  return bits.length ? `If ${bits.join('; ')}` : null;
}

function describeAction(a, ctx) {
  const primary = ctx.primaryForm;
  const lines = [];
  let label = a._type;
  switch (a._type) {
    case 'SetFieldsFromCurrentScreen':
    case 'SetFieldsFromCurrentTransaction':
      label = a._type === 'SetFieldsFromCurrentScreen' ? 'Set Fields (current screen)' : 'Set Fields (current transaction)';
      lines.push(...assignmentLines(a.setFieldsList, ctx, primary));
      break;
    case 'SetFieldsFromForm':
      label = `Set Fields from '${a.readValuesFrom}'`;
      lines.push(...assignmentLines(a.setFieldsList, ctx, primary));
      if (matchOptions(a)) lines.push(matchOptions(a));
      break;
    case 'SetFieldsFromSQL':
      label = 'Set Fields from SQL';
      lines.push(`SQL: ${clip(a.sqlCommand, 400)}`, ...assignmentLines(a.setFieldsList, ctx, primary));
      break;
    case 'PushFieldsAction':
      label = `Push Fields to '${a.pushToForm}'`;
      if (a.pushIfQualification) lines.push(`If ${renderQualifier(a.pushIfQualification, ctx, { topLevel: false, otherForm: a.pushToForm })}`);
      for (const item of a.pushFieldsList || []) {
        const target = item.field && item.field.fieldId;
        lines.push(`'${fieldName(ctx, a.pushToForm, target)}' = ${renderAssign(assignOf(item), ctx)}`);
      }
      if (matchOptions(a)) lines.push(matchOptions(a));
      break;
    case 'MessageAction':
    case 'FilterMessageAction':
      label = `Message — ${MESSAGE_TYPES[a.messageType] || `type ${a.messageType}`} #${a.messageNum}`;
      if (a.messageText) lines.push(a.messageText);
      break;
    case 'RunProcessAction':
      label = 'Run Process';
      lines.push(a.commandLine);
      break;
    case 'DirectSqlAction':
      label = 'Direct SQL';
      lines.push(clip(a.command, 600));
      break;
    case 'CallGuideAction':
      label = `Call Guide '${a.guideName}'`;
      if (a.serverName && a.serverName !== '@') lines.push(`Server: ${a.serverName}`);
      break;
    case 'ExitGuideAction': label = a.closeAll ? 'Exit Guide (close all)' : 'Exit Guide'; break;
    case 'GotoGuideLabelAction': label = `Goto Guide Label '${a.label}'`; break;
    case 'CloseWindowAction': label = a.closeAll ? 'Close Window (all)' : 'Close Window'; break;
    case 'CommitChangesAction': label = 'Commit Changes'; break;
    case 'GotoAction': {
      const what = GOTO_TAGS[a.tag] || `tag ${a.tag}`;
      label = a.tag === 1 ? `Goto — ${what} '${fieldName(ctx, primary, a.fieldIdOrValue)}'` : `Goto — ${what} ${a.fieldIdOrValue}`;
      break;
    }
    case 'OpenWindowAction':
      label = `Open Window '${a.formName}'`;
      lines.push(`Mode: ${WINDOW_MODES[a.windowMode] || a.windowMode}${a.targetLocation ? `, target: ${a.targetLocation}` : ''}`);
      break;
    case 'ServiceAction':
      label = `Service '${a.serviceForm}'`;
      break;
    case 'DSOAction':
      label = 'Distributed Server Option';
      lines.push(a.commandLine);
      break;
    case 'ChangeFieldAction': {
      label = `Change Field '${fieldName(ctx, primary, a.fieldId)}'`;
      const props = Object.entries(a.props || {}).map(([id, v]) => `${DISPLAY_PROPS[id] ? titleCase(DISPLAY_PROPS[id]) : `property ${id}`} = ${renderValue(v)}`);
      if (a.accessOption) lines.push(`Access option: ${a.accessOption}`);
      lines.push(...props);
      break;
    }
    default:
      lines.push(clip(JSON.stringify(a), 300));
  }
  return { type: a._type, label, lines };
}

const bitsOf = (mask, table, labels) =>
  Object.entries(table)
    .filter(([bit]) => (mask & Number(bit)) !== 0)
    .map(([, name]) => labels[name] || titleCase(name));

function describeSchedule(tm) {
  if (!tm) return null;
  if (tm._type === 'EscalationInterval') {
    const parts = [];
    if (tm.days) parts.push(`${tm.days}d`);
    if (tm.hours) parts.push(`${tm.hours}h`);
    if (tm.minutes) parts.push(`${tm.minutes}m`);
    return `Every ${parts.join(' ') || `${tm.value}s`}`;
  }
  const days = isNum(tm.weekDayMask) && tm.weekDayMask > 0
    ? WEEKDAYS.filter((_, i) => tm.weekDayMask & (1 << i)).join(', ')
    : tm.allMonthDays ? 'every day' : 'selected month days';
  return `At ${String(tm.hours || '').replace(/[{}]/g, '') || '?'}:${String(tm.minute || 0).padStart(2, '0')} — ${days}`;
}

const iso = (ts) => (ts && isNum(ts.value) && ts.value > 0 ? new Date(ts.value * 1000).toISOString() : null);

const KIND_LABEL = { activeLink: 'Active Link', filter: 'Filter', escalation: 'Escalation' };

/** Full readable description of one workflow object. */
function describeObject(kind, obj, ctx) {
  const forms = Array.isArray(obj.formList) ? obj.formList : [];
  const c = { ...ctx, primaryForm: ctx.primaryForm || obj.primaryForm || forms[0] || null };
  const mask = kind === 'activeLink' ? obj.executeMask : kind === 'filter' ? obj.opSet : null;
  const executeOn = kind === 'activeLink' ? bitsOf(mask || 0, EXECUTE_ON, EXECUTE_ON_LABELS)
    : kind === 'filter' ? bitsOf(mask || 0, FILTER_OPS, FILTER_OP_LABELS) : [];
  const props = obj.properties || {};
  return {
    kind,
    kindLabel: KIND_LABEL[kind],
    name: obj.name,
    enabled: obj.enable !== false,
    order: isNum(obj.order) ? obj.order : null,
    primaryForm: c.primaryForm,
    forms,
    executeOn,
    runIf: renderQualifier(obj.qualifier, c) || '',
    schedule: kind === 'escalation' ? describeSchedule(obj.escalationTm) : null,
    actions: (obj.actionList || []).map((a) => describeAction(a, c)),
    elseActions: (obj.elseList || []).map((a) => describeAction(a, c)),
    owner: obj.owner || null,
    lastChangedBy: obj.lastChangedBy || null,
    lastChanged: iso(obj.lastUpdateTime),
    application: props['90002'] && props['90002'].v ? String(props['90002'].v) : null,
    helpText: obj.helpText || null
  };
}

/** Every form name an object refers to — so the caller can resolve field names up front. */
function referencedForms(obj) {
  const found = new Set();
  const walk = (n, key) => {
    if (Array.isArray(n)) return n.forEach((x) => walk(x, key));
    if (!n || typeof n !== 'object') {
      if (typeof n === 'string' && n && n !== '@' && n !== '*' &&
        ['form', 'readValuesFrom', 'pushToForm', 'formName', 'serviceForm', 'primaryForm'].includes(key)) found.add(n);
      return;
    }
    for (const [k, v] of Object.entries(n)) walk(v, k);
  };
  // formList can hold hundreds of forms; only the primary one (and forms the actions name) matter for field names
  const { formList, ...rest } = obj;
  walk(rest, '');
  const primary = obj.primaryForm || (Array.isArray(formList) && formList[0]);
  if (primary) found.add(primary);
  return [...found];
}

module.exports = {
  renderQualifier, renderValue, renderAssign, describeAction, describeObject, describeSchedule,
  referencedForms, REL_OPS
};
