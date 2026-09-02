import { Component } from 'obsidian';

const LONG_PRESS_MS = 500;
/** Grace window for a synthetic click fired right after the long-press touchend. */
const SYNTHETIC_CLICK_MS = 350;
/** Safety net: how long click suppression may survive without any click. */
const SUPPRESS_RESET_MS = 1000;

export type MenuAnchor = MouseEvent | { x: number; y: number };

/**
 * Shared right-click (contextmenu) / long-press (500 ms touch) wiring for
 * opening an Obsidian Menu from a delegated container. Mobile browsers fire a
 * synthetic click — and sometimes a duplicate contextmenu — right after the
 * long-press touchend; both are suppressed so the menu doesn't instantly
 * re-trigger the row/card's primary action. All listeners go through the
 * owning component's registerDomEvent, so they die with the view; call
 * unload() from the view's onClose to clear pending timers.
 */
export class LongPressMenu {
	private component: Component;
	private container: HTMLElement;
	private selector: string;
	private showMenu: (target: HTMLElement, anchor: MenuAnchor) => void;
	private timer: number | null = null;
	private suppressNextClick = false;
	private resetTimer: number | null = null;

	constructor(
		component: Component,
		container: HTMLElement,
		selector: string,
		showMenu: (target: HTMLElement, anchor: MenuAnchor) => void
	) {
		this.component = component;
		this.container = container;
		this.selector = selector;
		this.showMenu = showMenu;

		this.component.registerDomEvent(this.container, 'contextmenu', (e: MouseEvent) => {
			const target = (e.target as HTMLElement).closest<HTMLElement>(this.selector);
			if (!target) return;
			e.preventDefault();
			// Some mobile browsers fire contextmenu right after a long-press;
			// the touch handler already opened the menu in that case.
			if (this.suppressNextClick) return;
			this.showMenu(target, e);
		});
		this.component.registerDomEvent(this.container, 'touchstart', (e: TouchEvent) => {
			const target = (e.target as HTMLElement).closest<HTMLElement>(this.selector);
			if (!target) return;
			const touch = e.touches[0];
			if (!touch) return;
			const position = { x: touch.clientX, y: touch.clientY };
			this.clearTimer();
			this.timer = window.setTimeout(() => {
				this.timer = null;
				this.suppressNextClick = true;
				this.showMenu(target, position);
				// Safety net: if the menu is dismissed without a synthetic click
				// (Escape key or a tap outside the container), don't let the flag
				// swallow the next real click.
				this.resetSuppressionAfter(SUPPRESS_RESET_MS);
			}, LONG_PRESS_MS);
		});
		this.component.registerDomEvent(this.container, 'touchmove', () => this.clearTimer());
		this.component.registerDomEvent(this.container, 'touchend', () => {
			this.clearTimer();
			// The press that opened the menu just ended; leave a brief window
			// for a synthetic click to be swallowed, then release the flag.
			if (this.suppressNextClick) this.resetSuppressionAfter(SYNTHETIC_CLICK_MS);
		});
		this.component.registerDomEvent(this.container, 'touchcancel', () => this.clearTimer());
	}

	/**
	 * Call at the top of the container's delegated click handler. Returns true
	 * (and prevents the event) when the click was the synthetic tail of a
	 * long-press and must be swallowed.
	 */
	swallowClick(e: MouseEvent): boolean {
		if (!this.suppressNextClick) return false;
		this.clearSuppression();
		e.preventDefault();
		return true;
	}

	/** Clear pending timers and the suppression flag (view onClose). */
	unload(): void {
		this.clearTimer();
		this.clearSuppression();
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** Release the click-suppression flag and cancel any pending reset. */
	private clearSuppression(): void {
		this.suppressNextClick = false;
		if (this.resetTimer !== null) {
			window.clearTimeout(this.resetTimer);
			this.resetTimer = null;
		}
	}

	/** Clear the click-suppression flag after `delay` ms, replacing any pending reset. */
	private resetSuppressionAfter(delay: number): void {
		if (this.resetTimer !== null) window.clearTimeout(this.resetTimer);
		this.resetTimer = window.setTimeout(() => {
			this.resetTimer = null;
			this.suppressNextClick = false;
		}, delay);
	}
}
