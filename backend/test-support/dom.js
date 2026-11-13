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
  for (const select of document.querySelectorAll('select')) {
    Object.defineProperty(select, 'value', { writable: true, value: select.querySelector('option[selected], option')?.value || '' });
  }
  for (const input of document.querySelectorAll('input[type="file"]')) {
    input.files = [];
    input.setCustomValidity = (message) => { input.validationMessage = message; };
    input.reportValidity = () => !input.validationMessage;
  }
  class BrowserFormData extends FormData {
    constructor(form) {
      super();
      if (form) for (const field of form.querySelectorAll('input[name], textarea[name], select[name]')) {
        if (!field.disabled && (field.type !== 'checkbox' || field.checked)) this.append(field.name, field.value || '');
      }
    }
  }
  const context = vm.createContext({ window, document, Event: window.Event, FormData: BrowserFormData, URLSearchParams, fetch: request });
  const run = (script) => vm.runInContext(readFileSync(new URL(`../../admin/dashboard/assets/${script}.js`, import.meta.url), 'utf8'), context);
  const event = (node, type, props = {}) => {
    const value = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(value, props);
    node.dispatchEvent(value);
    return value;
  };
  return { window, document, navigations, run, event };
}
