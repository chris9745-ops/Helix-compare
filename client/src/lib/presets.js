// Common starting points only — exact form/field names vary across ITSM
// versions and modules, so these are suggestions to edit, not trusted blindly.
// Used by Compare (form + key field) and Forms & Fields (form name suggestions).
export const DATA_PRESETS = [
  { label: 'Support Groups', formName: 'CTM:Support Group', keyField: 'Support Group Name' },
  { label: 'People', formName: 'CTM:People', keyField: 'Remedy Login ID' },
  { label: 'Company', formName: 'CTM:Company', keyField: 'Company Name' },
  { label: 'Operational Categorization', formName: 'CFG:Categorization', keyField: 'Name' },
  { label: 'Service Requests', formName: 'SRM:Request', keyField: 'Request Number' },
  { label: 'Incidents', formName: 'HPD:Help Desk', keyField: 'Incident Number' },
  { label: 'Changes', formName: 'CHG:Infrastructure Change', keyField: 'Infrastructure Change ID' },
  { label: 'Problems', formName: 'PBM:Problem Investigation', keyField: 'Problem Investigation ID' },
];
