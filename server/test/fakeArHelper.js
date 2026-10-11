// Stand-in for workflow-helper/ar-helper.js: same JSON-lines protocol, canned data shaped like the
// real helper's output (captured from a 26.3 Dev server, trimmed). Lets the service and routes be
// tested with no Java, no gateway and no Helix.
const readline = require('node:readline');

const FIELDS = {
  'HPD:Help Desk': [{ id: 7, name: 'Status', dt: 6 }, { id: 8, name: 'Short Description', dt: 4 }, { id: 1000000082, name: 'Company', dt: 4 }],
  'CTM:Support Group': [{ id: 1000000001, name: 'Support Group Name', dt: 4 }, { id: 1000000079, name: 'Company', dt: 4 }]
};

const rel = (op, l, r) => ({ op: 'rel', rel: op, l, r });
const field = (id, t = 99) => ({ t, v: id });
const val = (dt, v) => ({ t: 2, v: { dt, v } });

const OBJECTS = {
  filter: {
    'HPD:INC:ResolveStatus_100': {
      _type: 'Filter', name: 'HPD:INC:ResolveStatus_100', enable: true, order: 100, opSet: 6,
      formList: ['HPD:Help Desk'], primaryForm: 'HPD:Help Desk', owner: 'Remedy',
      lastChangedBy: 'Demo', lastUpdateTime: { _type: 'Timestamp', value: 1587576885 },
      properties: { 90002: { dt: 4, v: 'Remedy Change Management' } },
      qualifier: {
        op: 'and',
        l: rel(1, field(7), val(6, 4)),
        r: rel(6, field(8), val(0, null))
      },
      actionList: [
        {
          _type: 'SetFieldsFromForm', readValuesFrom: 'CTM:Support Group', noMatchOption: 2, multiMatchOption: 3,
          setFieldsList: [{
            _type: 'FieldAssignInfo', fieldId: 1000000082,
            assignment: {
              _type: 'AssignInfo', assignType: 2,
              field: {
                _type: 'AssignFieldInfo', form: 'CTM:Support Group', fieldId: 1000000079,
                qualifier: rel(1, field(1000000001, 1), field(8, 99))
              }
            }
          }]
        },
        { _type: 'FilterMessageAction', messageType: 2, messageNum: 1291409, messageText: 'Resolution is required.' }
      ],
      elseList: []
    }
  },
  activeLink: {
    'HPD:INC:ClearVendor_100': {
      _type: 'ActiveLink', name: 'HPD:INC:ClearVendor_100', enable: false, order: 100, executeMask: 17,
      formList: ['HPD:Help Desk'], primaryForm: 'HPD:Help Desk', qualifier: null, properties: {},
      actionList: [{
        _type: 'SetFieldsFromCurrentScreen',
        setFieldsList: [{ _type: 'FieldAssignInfo', fieldId: 8, assignment: { _type: 'AssignInfo', assignType: 1, value: { dt: 1, v: 1 } } }]
      }],
      elseList: []
    }
  },
  escalation: {}
};

const NAMES = {
  activeLink: { 'HPD:Help Desk': ['HPD:INC:ClearVendor_100'], '*': ['HPD:INC:ClearVendor_100', 'SHR:Other_AL'] },
  filter: { 'HPD:Help Desk': ['HPD:INC:ResolveStatus_100'], '*': ['HPD:INC:ResolveStatus_100', 'CTM:SG:Validate'] },
  escalation: { 'HPD:Help Desk': [], '*': [] }
};

let connected = false;
const handlers = {
  hello: () => ({ protocol: 1, connected }),
  connect: (r) => {
    if (r.password === 'bad') throw new Error('ERROR (623): Authentication failed');
    connected = true;
    return { host: r.host, port: r.port, user: r.user };
  },
  listForms: () => ['HPD:Help Desk', 'CTM:Support Group'],
  listWorkflow: (r) => (NAMES[r.kind][r.form || '*'] || []),
  getFields: (r) => { if (!FIELDS[r.form]) throw new Error(`Form does not exist: ${r.form}`); return FIELDS[r.form]; },
  getObject: (r) => {
    const o = OBJECTS[r.kind][r.name];
    if (!o) throw new Error(`ERROR (2): ${r.name} does not exist`);
    return o;
  },
  crash: () => process.exit(7),
  exit: () => { setImmediate(() => process.exit(0)); return true; }
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  const res = { id: req.id };
  try {
    if (req.cmd !== 'connect' && req.cmd !== 'hello' && req.cmd !== 'exit' && req.cmd !== 'crash' && !connected) throw new Error('Not connected');
    res.result = handlers[req.cmd](req);
    res.ok = true;
  } catch (e) { res.ok = false; res.error = e.message; }
  process.stdout.write(`${JSON.stringify(res)}\n`);
});
