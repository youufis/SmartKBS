const fs = require('fs');
const dir = 'D:/SmartKBS/frontend/public/locales';

// Only garbage keys created by the buggy fix_i18n.cjs script
const garbageKeys = [
  'Failed', 'operationFailed', 'SuccessSuccesssuccess',
  'msgu89r', 'dataerrorFailed', 'AI',
  'msgh8jr', 'msgb0t0', 'IPSuccessdataremaining',
  'Success', 'pleaseHint',
];

['zh-CN', 'en'].forEach(lang => {
  const file = dir + '/' + lang + '/system.json';
  const raw = fs.readFileSync(file, 'utf8');
  // Remove duplicate keys by re-serializing
  const data = JSON.parse(raw);
  
  // Remove garbage keys
  let removed = 0;
  garbageKeys.forEach(k => {
    if (k in data) {
      delete data[k];
      removed++;
    }
  });
  
  // Also remove any key with Chinese value in EN file
  if (lang === 'en') {
    Object.entries(data).forEach(([k, v]) => {
      if (typeof v === 'string' && /[\u4e00-\u9fff]/.test(v) && k !== 'classUnit') {
        delete data[k];
        removed++;
        console.log('  Deleted EN garbage: ' + k + ' = ' + v.substring(0, 30));
      }
    });
  }
  
  // Re-serialize to remove any duplicates (JSON.parse keeps last value)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(lang + '/system.json: cleaned, ' + Object.keys(data).length + ' keys remain');
  
  // Check for remaining Chinese in EN
  if (lang === 'en') {
    Object.entries(data).forEach(([k, v]) => {
      if (typeof v === 'string' && /[\u4e00-\u9fff]/.test(v)) {
        console.log('  WARNING: remaining Chinese in EN: ' + k + ' = ' + v.substring(0, 40));
      }
    });
  }
});

console.log('Done');
