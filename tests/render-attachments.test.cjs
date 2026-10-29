const fs = require('node:fs');
const assert = require('node:assert/strict');
const failures = [];
const elements = new Map();
let throwOnMessageAppend = false;
function makeElement(tag) {
  return {
    tag, children: [], className: '', textContent: '', style: {}, dataset: {},
    classList: { add(){}, remove(){}, contains(){return false;} },
    setAttribute(name, value) { this[`_${name}`] = value; }, append(...children) { if (throwOnMessageAppend && this.tag === 'root') { throwOnMessageAppend = false; throw new Error('simulated second message append failure'); } this.children.push(...children); }, appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children.flatMap((child) => child.tag === 'fragment' ? child.children : [child]); }, cloneNode() { return makeElement(this.tag); }, addEventListener(){}, replaceWith(node) { this.replacedBy = node; }, focus(){}, remove(){ this.removed = true; },
    querySelector(selector) {
      const match = (node) => node && (selector.startsWith('.') ? node.className === selector.slice(1) : node.tag === selector);
      const visit = (node) => { for (const child of node.children || []) { if (match(child)) return child; const found = visit(child); if (found) return found; } return null; };
      return visit(this);
    },
    set href(value) { this._href = value; }, set src(value) { this._src = value; },
    set alt(value) { this._alt = value; }, set loading(value) { this._loading = value; },
    set target(value) { this._target = value; }, set rel(value) { this._rel = value; }, set download(value) {}, set title(value) {}, set id(value) {}, set type(value) {}, set maxLength(value) {}, set value(value) { this._value = value; }, get value() { return this._value || ''; },
  };
}
const document = {
  createDocumentFragment() { return makeElement('fragment'); },
  createElement: makeElement,
  createTextNode(text) { return { tag: '#text', textContent: String(text), children: [] }; },
  querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, makeElement('root'));
    return elements.get(selector);
  },
};
const sandboxModule = { exports: {} };
const source = fs.readFileSync('public/app.js', 'utf8')
  .replace("'use strict';", "'use strict'; module.exports = { renderMessage, linkifyText, openLightbox };");
const makeWindow = () => ({location:{protocol:'http:',host:'localhost'},prompt(){},confirm(){return true},crypto:{randomUUID(){return 'test-client'}}});
new Function('document','localStorage','window','WebSocket','fetch','console','FormData','module','setTimeout','clearTimeout','requestAnimationFrame','cancelAnimationFrame',source)(
  document, {getItem(){return ''},setItem(){}}, makeWindow(),
  {OPEN:1,CONNECTING:0}, async()=>({ok:true,json:async()=>[]}), {error(...args){failures.push(args)}},
  class FormData {append(){}}, sandboxModule, setTimeout, clearTimeout,
  (callback) => { callback(); return 1; }, () => {},
);
const { renderMessage, linkifyText, openLightbox } = sandboxModule.exports;
renderMessage({nickname:'Tester',createdAt:new Date().toISOString(),text:'QR image',attachment:{url:'/uploads/qr.png',name:'qr.png',size:120,type:'image/png'}});
renderMessage({nickname:'Tester',createdAt:new Date().toISOString(),text:'PNG mime missing',attachment:{url:'/uploads/qr-2.png',name:'qr-2.png',size:120,type:'application/octet-stream'}});
renderMessage({nickname:'Tester',createdAt:new Date().toISOString(),text:'PDF',attachment:{url:'/uploads/doc.pdf',name:'doc.pdf',size:90510,type:'application/pdf'}});
renderMessage({nickname:'Tester',createdAt:new Date().toISOString(),text:'PDF MIME missing',attachment:{url:'/uploads/doc-2.pdf',name:'doc-2.pdf',size:90510,type:'application/octet-stream'}});
renderMessage({nickname:'Tester',createdAt:new Date().toISOString(),text:'Malformed attachment',attachment:{url:'/uploads/a',type:23}});
renderMessage({nickname:'',createdAt:'invalid',attachment:null});
const messages = elements.get('#messages').children;
assert.equal(messages.length, 6);
assert.equal(messages[0].children[1].children[2].tag, 'a');
assert.equal(messages[0].children[1].children[2].children[0].tag, 'img');
assert.equal(messages[1].children[1].children[2].children[0].tag, 'img');
assert.equal(messages[2].children[1].children[2].className, 'pdf-preview-card');
assert.equal(messages[2].children[1].children[2].children[0].textContent, '📄 doc.pdf');
assert.equal(messages[3].children[1].children[2].className, 'pdf-preview-card');
// Reproduce both requested back-to-back upload sequences and a fault on the second render.
for (const [first, second] of [
  [{name:'first.png',type:'image/png',url:'/uploads/first.png'}, {name:'second.pdf',type:'application/pdf',url:'/uploads/second.pdf'}],
  [{name:'first.png',type:'image/png',url:'/uploads/first.png'}, {name:'second.png',type:'image/png',url:'/uploads/second.png'}],
]) {
  const before = elements.get('#messages').children.length;
  renderMessage({id:100 + before,nickname:'Tester',createdAt:new Date().toISOString(),attachment:first});
  renderMessage({id:101 + before,nickname:'Tester',createdAt:new Date().toISOString(),attachment:second});
  assert.equal(elements.get('#messages').children.length, before + 2, 'each attachment pair renders independently');
  assert.equal(elements.has('#message-form'), true, 'composer form remains after the attachment pair');
}
const beforeFault = elements.get('#messages').children.length;
throwOnMessageAppend = true;
renderMessage({id:999,nickname:'Tester',createdAt:new Date().toISOString(),attachment:{url:'/uploads/fault.pdf',name:'fault.pdf',type:'application/pdf'}});
renderMessage({id:1000,nickname:'Tester',createdAt:new Date().toISOString(),attachment:{url:'/uploads/next.png',name:'next.png',type:'image/png'}});
assert.equal(elements.get('#messages').children.length, beforeFault + 1, 'failed list append does not disrupt following message rendering');
assert.equal(elements.get('#messages').children.at(-1).querySelector('img')?.tag, 'img');
assert.equal(elements.has('#message-form'), true, 'composer form remains after a simulated message render crash');
const linkified = makeElement('p');
linkifyText(linkified, 'safe <script>alert(1)</script> https://example.com/path.');
assert.equal(linkified.children.some((node) => node.tag === 'a' && node._href === 'https://example.com/path'), true);
assert.equal(linkified.children.some((node) => node.tag === 'a' && node._rel === 'noopener'), true);
assert.equal(linkified.children.some((node) => node.tag === 'script'), false);
assert.equal(failures.length, 1, 'the simulated render exception is caught and logged once');
console.log('PASS: image→PDF and image→image pairs, isolated render fault, composer persistence, safe linkify');
