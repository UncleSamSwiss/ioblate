#!/usr/bin/env node

const fs = require('fs');
const glob = require('glob');
const esprima = require('esprima');
const safeEval = require('safe-eval');

console.log('ioblate: ioBroker translation converter');

switch (process.argv[2] || '') {
  case 'load':
    load();
    break;
  case 'save':
    save();
    break;
  default:
    console.error('Usage: ioblate load|save\n');
    console.error('Please provide either "load" or "save" command');
    process.exit(-1);
}

function load() {
  // search all *.js files for translations
  glob('{,!(node_modules)/**/}*.js', function(err, files) {
    let foundTranslations = {};
    let allKeys = {};
    files.forEach(file => {
      try {
        let content = fs.readFileSync(file, { encoding: 'utf-8' });
        esprima.parseScript(content, { range: true }, (node, meta) => {
          if (isSystemDictionaryAssignment(node)) {
            let right = node.expression.right;
            let s = meta.start;
            let e = meta.end;
            console.log(
              `Found systemDictionary in ${file} ` +
                `from ${s.line}:${s.column} to ${e.line}:${e.column}`
            );
            let json = safeEval(content.substring(...right.range));
            for (const [key, languages] of Object.entries(json)) {
              console.log(' ', key, languages);
              for (const [lang, translation] of Object.entries(languages)) {
                foundTranslations[lang] = foundTranslations[lang] || {};
                foundTranslations[lang][file] =
                  foundTranslations[lang][file] || {};
                foundTranslations[lang][file][key] = translation;
                allKeys[file] = allKeys[file] || [];
                allKeys[file].push(key);
              }
            }
          }
        });
      } catch (error) {
        console.log(`Couldn't parse file ${file}: ${error}`);
      }
    });

    //console.log(foundTranslations);
    fs.mkdirSync('./i18n/', { recursive: true });
    for (const [lang, fileTranslations] of Object.entries(foundTranslations)) {
      let filename = `./i18n/words-${lang}.json`;
      let data = null;
      if (!fs.existsSync(filename)) {
        // if the file doesn't exist, we can simply create it with the JSON
        console.log(`Creating ${filename}`);
        data = fileTranslations;
      } else {
        // the file exists, we modify it where needed
        console.log(`Updating ${filename}`);
        let content = fs.readFileSync(filename, { encoding: 'utf-8' });
        data = JSON.parse(content);
        let changed = false;

        // add new files / translations
        for (const [file, translations] of Object.entries(fileTranslations)) {
          if (!data.hasOwnProperty(file)) {
            console.log(`  + adding ${file}`);
            data[file] = translations;
            changed = true;
          } else {
            for (const [key, translation] of Object.entries(translations)) {
              if (!data[file].hasOwnProperty(key)) {
                console.log(`  + ${key}: ${translation}`);
                data[file][key] = translation;
                changed = true;
              }
            }
          }
        }

        // remove obsolete files / translations
        for (const [file, translations] of Object.entries(data)) {
          if (!allKeys.hasOwnProperty(file)) {
            console.log(`  - removing ${file}`);
            delete data[file];
            changed = true;
          } else {
            for (const [key, translation] of Object.entries(translations)) {
              if (!allKeys[file].includes(key)) {
                console.log(`  - ${key}: ${translation}`);
                delete translations[key];
                changed = true;
              }
            }
          }
        }

        if (!changed) {
          console.log('  = no changes');
          continue;
        }
      }

      fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    }
  });
}

function save() {
  // search all ./i18n/words-*.json files for translations
  glob('./i18n/words-*.json', function(err, files) {
    let allTranslations = {};
    files.forEach(file => {
      let lang = file.replace(/^.*words-([^.]+).json$/, '$1');
      let data = JSON.parse(fs.readFileSync(file, { encoding: 'utf-8' }));
      for (const [file, translations] of Object.entries(data)) {
        allTranslations[file] = allTranslations[file] || {};
        for (const [key, translation] of Object.entries(translations)) {
          allTranslations[file][key] = allTranslations[file][key] || {};
          allTranslations[file][key][lang] = translation;
        }
      }
    });

    //console.log(allTranslations);
    for (const [file, translations] of Object.entries(allTranslations)) {
      if (!fs.existsSync(file)) {
        console.log(`Couldn't find ${file}, ignoring it!`);
        continue;
      }
      console.log(`Updating ${file}`);
      try {
        let content = fs.readFileSync(file, { encoding: 'utf-8' });
        let replacements = [];
        esprima.parseScript(content, { range: true }, (node, meta) => {
          if (isSystemDictionaryAssignment(node)) {
            let right = node.expression.right;
            let s = meta.start;
            let e = meta.end;
            console.log(
              `  Found systemDictionary ` +
                `from ${s.line}:${s.column} to ${e.line}:${e.column}`
            );
            let data = safeEval(content.substring(...right.range));
            for (const [key, languages] of Object.entries(data)) {
              for (const language of Object.keys(languages)) {
                // replace existing language translations
                data[key][language] = translations[key][language];
                delete translations[key][language];
              }

              // add all languages that were previously missing
              data[key] = { ...data[key], ...translations[key] };
            }

            replacements.push({
              start: right.range[0],
              end: right.range[1],
              data: data,
            });
          }
        });

        // replace all found sections from the end to the beginning of the file
        replacements
          .sort((a, b) => b.end - a.end)
          .forEach(replacement => {
            content =
              content.slice(0, replacement.start) +
              JSON.stringify(replacement.data, null, 2) +
              content.slice(replacement.end);
          });
        console.log(`  Replacing ${replacements.length} section(s) of ${file}`);
        fs.writeFileSync(file, content);
      } catch (error) {
        console.log(`Couldn't update file ${file}: ${error}`);
      }
    }
  });
}

function isSystemDictionaryAssignment(node) {
  // is this AST node an expression in the format "systemDictionary = {...}"?
  return (
    node.type == 'ExpressionStatement' &&
    node.expression.type == 'AssignmentExpression' &&
    node.expression.operator == '=' &&
    node.expression.left.type == 'Identifier' &&
    node.expression.left.name == 'systemDictionary'
  );
}
