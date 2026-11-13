import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const flush = () => new Promise((resolve) => setImmediate(resolve));

export function page(name, request) {
  const { window, document } = parseHTML(readFileSync(new URL(`../../admin/dashboard/${name}.html`, import.meta.url), 'utf8'));
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const navigations = [];
  window.location = { pathname: `/admin/${name}`, search: '', replace: (url) => navigations.push(url) };
  for (const form of document.querySelectorAll('form')) {
    Object.defineProperty(form, 'elements', { get: () => Object.fromEntries([...form.querySelectorAll('[name]')].map((field) => [field.name, field])) });
  }
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() {
      const selected = this.querySelector('option[selected]');
      const fallback = this.hasAttribute('multiple') ? null : this.querySelector('option:not([disabled]):not(optgroup[disabled] option)');
      return (selected || fallback)?.value || '';
    },
    set(value) {
      for (const option of this.querySelectorAll('option')) option.toggleAttribute('selected', option.value === value);
    }
  });
  for (const input of document.querySelectorAll('input[type="file"]')) {
    input.files = [];
    input.setCustomValidity = (message) => { input.validationMessage = message; };
    input.reportValidity = () => !input.validationMessage;
  }
  class BrowserFormData extends FormData {
    constructor(form) {
      super();
      if (form) for (const field of form.querySelectorAll('input[name], textarea[name], select[name]')) {
        if (field.disabled) continue;
        if (['checkbox', 'radio'].includes(field.type) && !(field.checked ?? field.hasAttribute('checked'))) continue;
        if (field.type === 'file') {
          const files = [...(field.files || [])];
          for (const file of files.length ? files : [new File([], '', { type: 'application/octet-stream' })]) this.append(field.name, file);
        } else if (field.tagName === 'SELECT' && field.hasAttribute('multiple')) {
          for (const option of field.querySelectorAll('option[selected]:not([disabled])')) this.append(field.name, option.value);
        } else {
          this.append(field.name, field.value || '');
        }
      }
    }
  }
  const context = vm.createContext({ window, document, Event: window.Event, FormData: BrowserFormData, URLSearchParams, fetch: request, AbortController, setTimeout, clearTimeout });
  const run = (script) => vm.runInContext(readFileSync(new URL(`../../admin/dashboard/assets/${script}.js`, import.meta.url), 'utf8'), context);
  const event = (node, type, props = {}) => {
    const value = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(value, props);
    node.dispatchEvent(value);
    return value;
  };
  return { window, document, navigations, run, event, FormData: BrowserFormData, context };
}
