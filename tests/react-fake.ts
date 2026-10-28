import type { ReactElement } from "react";

// React's hooks as far as the plugin's views use them, kept by hand for components rendered in a test. There is no
// React renderer in this repository, and the views are function components: calling one with its props gives the
// elements it draws, whose props hold what a screen reader is told and the handlers a press or a blur calls. A test
// file mocks `react` with `hooks` below (`vi.mock("react", ...)`), mounts a component, calls the handlers it finds, and
// renders again after each change, as React would. Effects run after each render whose dependencies changed, their
// clean-ups before the next run and at unmount. Elements of other components are found by their type and not drawn.

interface Effect {
  deps: readonly unknown[] | undefined;
  run: () => void | (() => void);
  cleanup: (() => void) | undefined;
  due: boolean;
}

class Instance<P> {
  readonly slots: unknown[] = [];
  readonly effects: Effect[] = [];
  index = 0;
  effectIndex = 0;
  dirty = false;
  mounted = true;
  tree: unknown = null;

  constructor(
    readonly component: (props: P) => unknown,
    public props: P,
  ) {}

  render(): unknown {
    if (!this.mounted) throw new Error("the component is unmounted");
    current = this as Instance<unknown>;
    this.index = 0;
    this.effectIndex = 0;
    this.dirty = false;
    try {
      this.tree = this.component(this.props);
    } finally {
      current = null;
    }
    for (const effect of this.effects) {
      if (!effect.due) continue;
      effect.due = false;
      effect.cleanup?.();
      const cleanup = effect.run();
      effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
    return this.tree;
  }

  unmount(): void {
    this.mounted = false;
    for (const effect of this.effects) effect.cleanup?.();
  }
}

let current: Instance<unknown> | null = null;

function instance(): Instance<unknown> {
  if (current === null) throw new Error("a hook was called outside a component that is being rendered");
  return current;
}

const sameDeps = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/** The hooks `react` is mocked with. */
export const hooks = {
  useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
    const owner = instance();
    const index = owner.index++;
    if (!(index in owner.slots)) owner.slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    const set = (next: T | ((previous: T) => T)): void => {
      const value = typeof next === "function" ? (next as (previous: T) => T)(owner.slots[index] as T) : next;
      if (Object.is(value, owner.slots[index])) return;
      owner.slots[index] = value;
      owner.dirty = true;
    };
    return [owner.slots[index] as T, set];
  },
  useRef<T>(initial: T): { current: T } {
    const owner = instance();
    const index = owner.index++;
    if (!(index in owner.slots)) owner.slots[index] = { current: initial };
    return owner.slots[index] as { current: T };
  },
  useMemo<T>(make: () => T, deps: readonly unknown[]): T {
    const owner = instance();
    const index = owner.index++;
    const slot = owner.slots[index] as { deps: readonly unknown[]; value: T } | undefined;
    if (slot !== undefined && sameDeps(slot.deps, deps)) return slot.value;
    const value = make();
    owner.slots[index] = { deps, value };
    return value;
  },
  useCallback<T>(callback: T, deps: readonly unknown[]): T {
    return hooks.useMemo(() => callback, deps);
  },
  useEffect(run: () => void | (() => void), deps?: readonly unknown[]): void {
    const owner = instance();
    const index = owner.effectIndex++;
    const effect = owner.effects[index];
    if (effect === undefined) owner.effects[index] = { deps, run, cleanup: undefined, due: true };
    else if (!sameDeps(effect.deps, deps)) Object.assign(effect, { deps, run, due: true });
  },
};

/** What a test holds of a mounted component: the elements it drew last, and the ways to render it again and to unmount it. */
export interface Mounted<P> {
  readonly tree: unknown;
  /** Renders again with these props, or with the ones it has. */
  render(props?: P): unknown;
  /** Waits for what is under way (promises that settle by themselves), and renders again for as long as a state changed. */
  settle(): Promise<unknown>;
  unmount(): void;
  readonly mounted: boolean;
}

export function mount<P>(component: (props: P) => unknown, props: P): Mounted<P> {
  const owner = new Instance(component, props);
  owner.render();
  const settle = async (): Promise<unknown> => {
    for (let round = 0; round < 50; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!owner.dirty || !owner.mounted) return owner.tree;
      owner.render();
    }
    throw new Error("the component kept changing its state");
  };
  return {
    get tree() {
      return owner.tree;
    },
    render(next?: P) {
      if (next !== undefined) owner.props = next;
      return owner.render();
    },
    settle,
    unmount: () => owner.unmount(),
    get mounted() {
      return owner.mounted;
    },
  };
}

type Element = ReactElement<Record<string, unknown>>;

function isElement(value: unknown): value is Element {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

/** Every element of a tree, depth first: the children of each are read from its props. */
export function elements(tree: unknown): Element[] {
  const found: Element[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isElement(node)) return;
    found.push(node);
    walk(node.props.children);
  };
  walk(tree);
  return found;
}

/** The elements of a tree of a type, and whose props have every member of `props`. */
export function findAll(tree: unknown, type: unknown, props: Record<string, unknown> = {}): Element[] {
  return elements(tree).filter((element) => element.type === type && Object.entries(props).every(([key, value]) => Object.is(element.props[key], value)));
}

/** The one element of a tree of a type, and whose props have every member of `props`. Fails when there is none, or more than one. */
export function find(tree: unknown, type: unknown, props: Record<string, unknown> = {}): Element {
  const found = findAll(tree, type, props);
  if (found.length !== 1) throw new Error(`expected one ${String((type as { name?: string })?.name ?? type)} with ${JSON.stringify(props)}, found ${found.length}`);
  return found[0] as Element;
}
