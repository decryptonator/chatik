const fs = require('node:fs');
const assert = require('node:assert/strict');
const failures = [];
const elements = new Map();
function makeElement(tag) {
  return {
    tag, children: [], className: '', textContent: '', style: {}, dataset: {},
    classList: { add(){}, remove(){} },
    setAttribute(){}, append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(){}, replaceWith(node) { this.replacedBy = node; }, focus(){},
    set href(value) { this._href = value; }, set src(value) { this._src = value; },
    set alt(value) { this._alt = value; }, set loading(value) { this._loading = value; },
    set target(value) {}, set rel(value) {}, set download(value) {},
  };
}
const document = {
  createElement: makeElement,
  querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, makeElement('root'));
    return elements.get(selector);
  },
};
const sandboxModule = { exports: {} };
const source = fs.readFileSync('public/app.js', 'utf8')
  .replace("'use strict';", "'use strict'; module.exports = { renderMessage };");
new Function('document','localStorage','window','WebSocket','fetch','console','FormData','module','setTimeout','clearTimeout',source)(
  document, {getItem(){return ''},setItem(){}}, {location:{protocol:'http:',host:'localhost'},prompt(){}},
  {OPEN:1,CONNECTING:0}, async()=>({ok:true,json:async()=>[]}), {error(...args){failures.push(args)}},
  class FormData {append(){}}, sandboxModule, setTimeout, clearTimeout,
);
const { renderMessage } = sandboxModule.exports;
renderMessage({nickname:'Tester',createdAt:new Date().toISOString(),text:'QR image',attachment:{url:'/uploads/qr.png',name:'qr.png',size:120,type:'image/png'}});
renderMessage({nickname:'Tester',createdAt:new Date().toISOString(),text:'PDF',attachment:{url:'/uploads/doc.pdf',name:'doc.pdf',size:90510,type:'application/pdf'}});
renderMessage({nickname:'Tester',createdAt:new Date().toISOString(),text:'Malformed attachment',attachment:{url:'/uploads/a',type:23}});
renderMessage({nickname:'',createdAt:'invalid',attachment:null});
const messages = elements.get('#messages').children;
assert.equal(messages.length, 4);
assert.equal(messages[0].children[1].children[2].tag, 'a');
assert.equal(messages[0].children[1].children[2].children[0].tag, 'img');
assert.equal(messages[1].children[1].children[2].className, 'attachment-file');
assert.equal(messages[1].children[1].children[2].children[0].textContent, 'doc.pdf');
assert.equal(elements.has('#message-form'), true, 'composer form remains in the page');
assert.equal(failures.length, 0, 'attachment render did not throw');
console.log('PASS: image preview, PDF download card, malformed attachment isolation, composer remains present');
