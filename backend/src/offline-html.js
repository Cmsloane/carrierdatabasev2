import fs from 'node:fs';

function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function replaceVar(text, varDecl, newValue) {
  const marker = `${varDecl}=`;
  const start = text.indexOf(marker);
  if (start === -1) {
    throw new Error(`Could not find ${varDecl} in HTML template.`);
  }
  const valueStart = start + marker.length;
  let depth = 0;
  let index = valueStart;
  let inString = false;
  let stringChar = '';
  let escape = false;

  while (index < text.length) {
    const ch = text[index];
    if (escape) {
      escape = false;
      index += 1;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === stringChar) inString = false;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
      } else if (ch === '[' || ch === '{') {
        depth += 1;
      } else if (ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    index += 1;
  }

  if (text[index] === ';') index += 1;
  return `${text.slice(0, start)}${marker}${newValue};${text.slice(index)}`;
}

export function renderOfflineHtml({ templatePath, carriers, loadsData }) {
  const template = fs.readFileSync(templatePath, 'utf8');
  let html = replaceVar(template, 'let carriers', inlineJson(carriers));
  html = replaceVar(html, 'let loadsData', inlineJson(loadsData));
  return html;
}

export function exportOfflineHtml({ templatePath, outPath, carriers, loadsData }) {
  const html = renderOfflineHtml({ templatePath, carriers, loadsData });
  fs.writeFileSync(outPath, html, 'utf8');
  return html;
}
