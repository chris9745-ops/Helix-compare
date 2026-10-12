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

// Add a second form's worth of workflow used by the compare tests.
const filterObj = (name, qualifier, extra = {}) => ({
  _type: 'Filter', name, enable: true, order: 10, opSet: 2, formList: ['CTM:Support Group'],
  primaryForm: 'CTM:Support Group', owner: 'Remedy', properties: {},
  lastUpdateTime: { _type: 'Timestamp', value: 1600000000 }, lastChangedBy: 'Installer',
  qualifier, actionList: [], elseList: [], ...extra
});
OBJECTS.filter['CTM:SG:Validate'] = filterObj('CTM:SG:Validate', rel(1, field(1000000079), val(4, 'Calbro')));
OBJECTS.filter['CTM:SG:Same'] = filterObj('CTM:SG:Same', rel(6, field(1000000079), val(0, null)));
OBJECTS.activeLink['CTM:SG:DevOnlyAL'] = {
  _type: 'ActiveLink', name: 'CTM:SG:DevOnlyAL', enable: true, order: 5, executeMask: 1,
  formList: ['CTM:Support Group'], primaryForm: 'CTM:Support Group', qualifier: null, properties: {}, actionList: [], elseList: []
};
const FORM_NAMES = {
  filter: { 'CTM:Support Group': ['CTM:SG:Validate', 'CTM:SG:Same'] },
  activeLink: { 'CTM:Support Group': ['CTM:SG:DevOnlyAL'] },
  escalation: {}
};

// "Prod" is the same server with differences: one modified, one identical bar who last changed it,
// one Prod-only filter, and the Dev-only active link missing.
const clone = (o) => JSON.parse(JSON.stringify(o));
const PROD_OBJECTS = clone(OBJECTS);
PROD_OBJECTS.filter['CTM:SG:Validate'].qualifier = rel(1, field(1000000079), val(4, 'Federal'));
PROD_OBJECTS.filter['CTM:SG:Same'].lastChangedBy = 'Someone Else';
PROD_OBJECTS.filter['CTM:SG:Same'].lastUpdateTime = { _type: 'Timestamp', value: 1700000000 };
PROD_OBJECTS.filter['CTM:SG:Same'].formList = ['CTM:Support Group'];
PROD_OBJECTS.filter['CTM:SG:ProdOnly'] = filterObj('CTM:SG:ProdOnly', null);
delete PROD_OBJECTS.activeLink['CTM:SG:DevOnlyAL'];
const PROD_FORM_NAMES = clone(FORM_NAMES);
PROD_FORM_NAMES.filter['CTM:Support Group'].push('CTM:SG:ProdOnly');
PROD_FORM_NAMES.activeLink['CTM:Support Group'] = [];
const PROD_NAMES = clone(NAMES);
PROD_NAMES.filter['*'] = ['HPD:INC:ResolveStatus_100', 'CTM:SG:Validate', 'CTM:SG:Same', 'CTM:SG:ProdOnly'];
const DATASETS = {
  dev: { objects: OBJECTS, names: NAMES, formNames: FORM_NAMES },
  prod: { objects: PROD_OBJECTS, names: PROD_NAMES, formNames: PROD_FORM_NAMES }
};
let data = DATASETS.dev;

// ── layout fixtures: one base view and one translated copy of it ───────────────────────────────
const pt = (x, y) => ({ _type: 'CoordinateInfo', xCoordinate: x, yCoordinate: y });
const box = (x1, y1, x2, y2) => ({ dt: 41, v: [pt(x1, y1), pt(x2, y2)] });
const layoutField = (id, name, dt, over = {}) => ({
  id, name, dt, type: 1,
  props: {
    3: box(0, 0, 100, 20), 4: { dt: 6, v: 1 }, 5: { dt: 6, v: 2 }, 20: { dt: 4, v: name }, 143: { dt: 40, v: id },
    170: { dt: 40, v: 0 }, ...over
  }
});
const VIEWS_DEV = [
  { id: 10, name: 'Default Admin View', locale: '', props: { 20: { dt: 4, v: 'Default Administrator View' } } },
  { id: 11, name: 'Default Admin View_fr', locale: 'fr', props: { 20: { dt: 4, v: 'Default Administrator View' } } },
  { id: 12, name: 'DevOnlyView', locale: '', props: { 20: { dt: 4, v: 'Dev only' } } }
];
const LAYOUT_DEV = {
  10: [
    layoutField(1, 'Request ID', 4),
    layoutField(2, 'Status', 6, { 3: box(0, 40, 100, 60) }),
    layoutField(3, 'Notes', 5, { 3: box(0, 80, 200, 180) }),
    layoutField(4, 'Panel', 35, { 3: box(0, 200, 400, 500) }),
    layoutField(5, 'InsidePanel', 4, { 170: { dt: 40, v: 4 }, 3: box(10, 210, 110, 230) }),
    { id: 9, name: 'NotOnView', dt: 4, type: 1, props: null }
  ],
  12: [layoutField(1, 'Request ID', 4)]
};
const LAYOUT_PROD = JSON.parse(JSON.stringify(LAYOUT_DEV));
LAYOUT_PROD[10][1].props[20] = { dt: 4, v: 'State' };            // Status relabelled
LAYOUT_PROD[10][2].props[4] = { dt: 6, v: 0 };                    // Notes hidden
LAYOUT_PROD[10][0].props[3] = box(5, 0, 105, 20);                 // Request ID moved
LAYOUT_PROD[10][4].props[3] = box(10, 210, 210, 230);             // InsidePanel resized
LAYOUT_PROD[10].push(layoutField(6, 'ProdOnlyField', 4));         // only on Prod
LAYOUT_PROD[10].splice(0, 0);                                     // (Panel unchanged)
const PROD_VIEWS = VIEWS_DEV.filter((v) => v.name !== 'DevOnlyView');

let connected = false;
const handlers = {
  hello: () => ({ protocol: 1, connected }),
  connect: (r) => {
    if (r.password === 'bad') throw new Error('ERROR (623): Authentication failed');
    connected = true;
    data = Number(r.port) === 48000 ? DATASETS.prod : DATASETS.dev;
    return { host: r.host, port: r.port, user: r.user };
  },
  listForms: () => ['HPD:Help Desk', 'CTM:Support Group'],
  listWorkflow: (r) => {
    const names = data.names[r.kind][r.form || '*'] || [];
    if (r.since === undefined || r.since === null) return names;
    // like the real API: only objects modified after `since`
    return names.filter((n) => {
      const o = data.objects[r.kind][n];
      return o && o.lastUpdateTime && o.lastUpdateTime.value > r.since;
    });
  },
  getFields: (r) => { if (!FIELDS[r.form]) throw new Error(`Form does not exist: ${r.form}`); return FIELDS[r.form]; },
  getObject: (r) => {
    const o = data.objects[r.kind][r.name];
    if (!o) throw new Error(`ERROR (2): ${r.name} does not exist`);
    return o;
  },
  getObjectsBulk: (r) => {
    const names = r.form
      ? (data.formNames[r.kind][r.form] || data.names[r.kind][r.form] || [])
      : r.names;
    if (r.form === 'No Such Form') throw new Error('ERROR (303): Form does not exist on server');
    return names.map((n) => data.objects[r.kind][n]).filter(Boolean);
  },
  getViews: (r) => {
    if (r.form !== 'HPD:Help Desk') throw new Error('ERROR (303): Form does not exist on server');
    return data === DATASETS.prod ? PROD_VIEWS : VIEWS_DEV;
  },
  getFieldLayout: (r) => {
    const set = data === DATASETS.prod ? LAYOUT_PROD : LAYOUT_DEV;
    return set[r.viewId] || [];
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
