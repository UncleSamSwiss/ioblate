#!/usr/bin/env node

const fs = require('fs');
const glob = require('glob').sync;
const esprima = require('esprima');
const gumbo = require('gumbo-parser');
const safeEval = require('safe-eval');
const chardet = require('chardet');
var iconv = require('iconv-lite');

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
  let files = glob('{,!(node_modules)/**/}*.js');
  let foundTranslations = {};
  let allKeys = [];

  const parseScript = function(file, content) {
    esprima.parseScript(content, { range: true }, (node, meta) => {
      const parseObjectString = function(childNode) {
        let s = meta.start;
        let e = meta.end;
        console.log(
          `Found systemDictionary in ${file} ` +
            `from ${s.line}:${s.column} to ${e.line}:${e.column}`
        );
        let json = safeEval(content.substring(...childNode.range));
        for (const [key, languages] of Object.entries(json)) {
          console.log(' ', key, languages);
          const fullKey = `${file}#${key}`;
          for (const [lang, translation] of Object.entries(languages)) {
            foundTranslations[lang] = foundTranslations[lang] || {};
            foundTranslations[lang][fullKey] = translation;
            allKeys.push(fullKey);
          }
        }
      };
      try {
        if (isSystemDictionaryAssignment(node)) {
          parseObjectString(node.expression.right);
        } else if (isSystemDictionaryDeclaration(node)) {
          parseObjectString(node.init);
        }
      } catch (error) {
        console.log(`Couldn't parse expression: ${error}`);
      }
    });
  };
  files.forEach(file => {
    try {
      let content = readFileSync(file);
      parseScript(file, content);
    } catch (error) {
      console.log(`Couldn't parse file ${file}: ${error}`);
    }
  });

  if (allKeys.length == 0) {
    console.log('No translatable JavaScript files found, trying with HTML');
    files = glob('{,!(node_modules)/**/}*.htm*');
    files.forEach(file => {
      try {
        let content = readFileSync(file);
        let result = gumbo(content, {});
        traverseGumbo(result.document, node => {
          if (node.nodeName == 'script') {
            traverseGumbo(node, child => {
              if (child.nodeName == '#text') {
                parseScript(file, child.originalText);
              }
            });
          }
        });
      } catch (error) {
        console.log(`Couldn't parse file ${file}: ${error}`);
      }
    });
  }

  //console.log(foundTranslations);
  fs.mkdirSync('./i18n/', { recursive: true });
  for (const [lang, translations] of Object.entries(foundTranslations)) {
    let filename = `./i18n/words-${lang}.json`;
    let data = null;
    if (!fs.existsSync(filename)) {
      // if the file doesn't exist, we can simply create it with the JSON
      console.log(`Creating ${filename}`);
      data = translations;
    } else {
      // the file exists, we modify it where needed
      console.log(`Updating ${filename}`);
      let content = readFileSync(filename);
      data = JSON.parse(content);
      let changed = false;

      // add new translations
      for (const [key, translation] of Object.entries(translations)) {
        if (!data.hasOwnProperty(key)) {
          console.log(`  + ${key}: ${translation}`);
          data[key] = translation;
          changed = true;
        }
      }

      // remove obsolete translations
      for (const [key, translation] of Object.entries(translations)) {
        if (!allKeys.includes(key)) {
          console.log(`  - ${key}: ${translation}`);
          delete translations[key];
          changed = true;
        }
      }

      if (!changed) {
        console.log('  = no changes');
        continue;
      }
    }

    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }
}

function save() {
  // search all ./i18n/words-*.json files for translations
  const files = glob('./i18n/words-*.json');
  let allTranslations = {};
  files.forEach(file => {
    let lang = file.replace(/^.*words-([^.]+).json$/, '$1');
    let data = JSON.parse(readFileSync(file));
    for (const [fullKey, translation] of Object.entries(data)) {
      const [fileName, key] = fullKey.split('#', 2);
      allTranslations[fileName] = allTranslations[fileName] || {};
      allTranslations[fileName][key] = allTranslations[fileName][key] || {};
      allTranslations[fileName][key][lang] = translation;
    }
  });

  console.log(allTranslations);
  for (const [file, translations] of Object.entries(allTranslations)) {
    if (!fs.existsSync(file)) {
      console.log(`Couldn't find ${file}, ignoring it!`);
      continue;
    }
    console.log(`Updating ${file}`);

    const parseScript = function(content) {
      let replacements = [];
      esprima.parseScript(content, { range: true }, (node, meta) => {
        const parseObjectString = function(childNode) {
          let s = meta.start;
          let e = meta.end;
          console.log(
            `  Found systemDictionary ` +
              `from ${s.line}:${s.column} to ${e.line}:${e.column}`
          );
          let data = safeEval(content.substring(...childNode.range));
          for (const [key, languages] of Object.entries(data)) {
            for (const language of Object.keys(languages)) {
              // replace existing language translations
              data[key][language] = translations[key][language];
              delete translations[key][language];
            }

            // add all languages that were previously missing
            data[key] = { ...data[key], ...translations[key] };
          }

          // search for any spacing before the "systemDictionary = {"
          // we will use this as indent
          let prefix = content.substring(0, node.range[0]);
          let match = prefix.match(/[ \t]*$/);

          replacements.push({
            start: childNode.range[0],
            end: childNode.range[1],
            indent: !!match ? match[0] : '',
            data: data,
          });
        };
        try {
          if (isSystemDictionaryAssignment(node)) {
            parseObjectString(node.expression.right);
          } else if (isSystemDictionaryDeclaration(node)) {
            parseObjectString(node.init);
          }
        } catch (error) {
          console.log(`  Couldn't parse expression: ${error}`);
        }
      });
      return replacements;
    };
    try {
      let content = readFileSync(file);
      let replacements = [];
      if (file.match(/\.js$/i)) {
        replacements = parseScript(content);
      } else if (file.match(/\.html?$/i)) {
        // in HTML parse all scripts and use the found replacements
        // (which have to be offset by the script location of course)
        let result = gumbo(content, {});
        traverseGumbo(result.document, node => {
          if (node.nodeName == 'script') {
            traverseGumbo(node, child => {
              if (child.nodeName == '#text') {
                let scriptReplacements = parseScript(child.originalText);
                scriptReplacements.forEach(replacement => {
                  replacement.start += child.startPos.offset;
                  replacement.end += child.startPos.offset;
                  replacements.push(replacement);
                });
              }
            });
          }
        });
      } else {
        throw `Unsupported file extension in: ${file}`;
      }

      // replace all found sections from the end to the beginning of the file
      replacements
        .sort((a, b) => b.end - a.end)
        .forEach(replacement => {
          json = JSON.stringify(replacement.data, null, 2);
          content =
            content.slice(0, replacement.start) +
            json.replace(/(\r?\n)/g, `$1${replacement.indent}`) +
            content.slice(replacement.end);
        });
      console.log(`  Replacing ${replacements.length} section(s) of ${file}`);
      fs.writeFileSync(file, content);
    } catch (error) {
      console.log(`Couldn't update file ${file}: ${error}`);
    }
  }
}

function readFileSync(filename) {
  var encoding = chardet.detectFileSync(filename);
  if (encoding.startsWith('ISO') || encoding.startsWith('windows')) {
    //console.log(`Assuming ${filename} is windows-1251 encoded`);
    const buffer = fs.readFileSync(filename);
    return iconv.decode(buffer, 'win1251');
  }
  return fs.readFileSync(filename, { encoding: encoding });
}

function isSystemDictionaryAssignment(node) {
  // is this AST node an expression in the format "systemDictionary = {...}"?
  return (
    node.type == 'ExpressionStatement' &&
    node.expression.type == 'AssignmentExpression' &&
    node.expression.operator == '=' &&
    node.expression.left.type == 'Identifier' &&
    (node.expression.left.name == 'systemDictionary' ||
      node.expression.left.name == '_systemDictionary')
  );
}

function isSystemDictionaryDeclaration(node) {
  // is this AST node an expression in the format "var systemDictionary = {...}"?
  return (
    node.type == 'VariableDeclarator' &&
    node.id.type == 'Identifier' &&
    (node.id.name == 'systemDictionary' || node.id.name == '_systemDictionary')
  );
}

function traverseGumbo(node, callback) {
  callback(node);
  if (!!node.childNodes) {
    node.childNodes.forEach(child => traverseGumbo(child, callback));
  }
}
