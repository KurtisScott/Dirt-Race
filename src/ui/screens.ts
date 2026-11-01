/**
 * Minimal HTML screen helpers. Every screen is a full-viewport <div class="screen"> inside #ui.
 * Buttons use `data-tap` and are bound with `onTap` (pointerup → fires reliably on iOS
 * without the 300 ms click delay or double-tap zoom interference).
 */
export function h(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

export function onTap(el: Element, fn: (e: Event) => void): void {
  // `click` is a valid user-activation event on iOS (needed for permission + audio unlock).
  // touch-action: manipulation in CSS removes the delay.
  el.addEventListener('click', (e) => {
    e.preventDefault();
    fn(e);
  });
}

export class Screen {
  readonly el: HTMLElement;
  constructor(
    parent: HTMLElement,
    html: string,
    readonly name: string,
  ) {
    this.el = h(html);
    this.el.classList.add('screen');
    this.el.dataset.screen = name;
    this.hide();
    parent.appendChild(this.el);
  }
  show(): void {
    this.el.hidden = false;
  }
  hide(): void {
    this.el.hidden = true;
  }
  q<T extends HTMLElement = HTMLElement>(sel: string): T {
    const e = this.el.querySelector<T>(sel);
    if (!e) throw new Error(`[ui] ${this.name}: missing ${sel}`);
    return e;
  }
}
