import selParser from 'postcss-selector-parser';
import type { Selector, Attribute, Pseudo, Node, Container } from 'postcss-selector-parser';
import type { Plugin, AtRule, ChildNode, Root, Rule, Container as PostCSSContainer } from 'postcss';

type Diff<T, U> = T extends U ? never : T;
type SelectorChild = Diff<Node, Selector>;

export type GetScope = (root: Root) => string | undefined;

export interface ClassScopeOptions {
    /** Scope prefix to add to class names */
    prefix?: string;

    /** Scope suffix to add to class names */
    suffix?: string;

    /** Apply scoping to class names that match given regexp */
    include?: RegExp;

    /** Do not apply scoping to class names that match given regexp */
    exclude?: RegExp;

    /**
     * If `prefix` or `suffix` is given, create all possible combinations of selector.
     * Note that the amount of produced selectors is about N², where N is the amount
     * of class names in selector.
     * */
    full?: boolean;
}

export interface Options {
    scope?: string | GetScope;
    classScope?: boolean | ClassScopeOptions;
}

const processed = Symbol('processed');
const ignoreClassScopingPseudo = new Set([':host', ':host-context', '::slotted', '::global', '::local']);

export default function createPlugin(opt: GetScope | string | Options): Plugin {
    const animations = new Set<string>();
    let scope: string | undefined;
    const options: Options = typeof opt === 'string' || typeof opt === 'function'
        ? { scope: opt }
        : opt;

    const selProcessor = selParser(root => {
        const handleSelector = (sel: Selector) => {
            rewriteRefs(sel, scope);
            rewriteSlotted(sel, scope) || rewriteSelector(sel, scope);
            return sel;
        }

        root.each(sel => {
            if (options.classScope) {
                const classScope = getClassScopeOptions(scope, options.classScope);
                if (isGlobalClassScope(options.classScope)) {
                    for (const selCopy of scopeClassNamesInContainer(sel, classScope)) {
                        root.insertBefore(sel, handleSelector(selCopy));
                    }
                } else {
                    scopeClassNames(sel, classScope);
                }
            }

            handleSelector(sel);
        });
    });

    const shouldSkip = <T>(node: T) => {
        if (!scope || node[processed]) {
            return true;
        }

        markProcessed(node);
        return false;
    };

    return {
        postcssPlugin: 'endorphin',
        Once(root) {
            animations.clear();
            scope = typeof options.scope === 'function' ? options.scope(root) : options.scope;

            if (!scope)  {
                return;
            }

            root.walkAtRules(atrule => {
                if (isRewriteableKeyframe(atrule)) {
                    animations.add(atrule.params);
                }
            });
        },
        AtRuleExit(atrule) {
            if (shouldSkip(atrule)) {
                return;
            }

            const mediaScope = getMediaScope(atrule);
            if (mediaScope) {
                if (mediaScope === atrule.params) {
                    // A single `@media local|global`, remove atrule completely
                    atrule.cleanRaws();
                    atrule.replaceWith(atrule.nodes);
                } else {
                    atrule.params = atrule.params.replace(/(\s+and\s+)?(local|global)(\s+and\s+)?/g, '');
                }

                return;
            }

            if (isRewriteableKeyframe(atrule)) {
                atrule.params = concat(atrule.params, scope);
            }
        },
        Rule(rule) {
            if (shouldSkip(rule)) {
                return;
            }

            if (rule.parent) {
                if (isKeyframe(rule.parent)) {
                    return;
                }

                const mediaScope = getMediaScope(rule.parent);
                if (mediaScope) {
                    if (mediaScope === 'local') {
                        rule.selectors = rule.selectors.map(sel => `[${scope}-host] ${sel}`);
                    }

                    if (isGlobalClassScope(options.classScope) && (mediaScope === 'local' || mediaScope === 'global')) {
                        scopeClassNamesInRule(rule, options.classScope);
                    }

                    return;
                }
            }

            rule.selector = selProcessor.processSync(rule.selector);
        },
        Declaration(decl) {
            if (shouldSkip(decl)) {
                return;
            }

            const name = cssName(decl.prop);
            if (name === 'animation-name' && animations.has(decl.value)) {
                decl.value = concat(decl.value, scope);
            } else if (name === 'animation') {
                decl.value = decl.value.split(' ')
                    .map(chunk => animations.has(chunk) ? concat(chunk, scope) : chunk)
                    .join(' ');
            }
        }
    }
}

createPlugin.postcss = true;

/**
 * Scopes given CSS selector
 */
function rewriteSelector(sel: Selector, scope: string) {
    // To properly scope CSS selector, we have to rewrite fist and last part of it.
    // E.g. in `.foo .bar. > .baz` we have to scope `.foo` and `.baz` only
    const parts = getCompound(sel);
    const specialPseudo = ['::global', '::local'];
    const localGlobal: Pseudo[] = [];
    const scopable = parts.filter(part => {
        if (part.type === 'pseudo' && specialPseudo.includes(part.value)) {
            localGlobal.push(part);
            return false;
        }

        return true;
    });

    const first = scopable.shift();
    const last = scopable.pop();

    first && rewriteSelectorPart(sel, first, scope);
    last && rewriteSelectorPart(sel, last, scope);

    if (localGlobal.length) {
        // Since ::global() and ::local() may contain multiple selectors, we have
        // to create a copy of a parent selector for each nested selector
        // and replace pseudo reference with nested selector, e.g. `div ::global(a, b) span`
        // should be transformed into `div a span, div b span`.
        const replacements: Selector[] = [sel.clone({}) as Selector];

        while (localGlobal.length) {
            const part = localGlobal.pop();
            const ix = sel.index(part);
            if (ix !== -1) {
                for (let i = replacements.length - 1; i >= 0; i--) {
                    const innerReplacements: Selector[] = [];

                    for (const childSel of part.nodes) {
                        const sel = replacements[i].clone({}) as Selector;
                        const item = sel.at(ix);

                        if (part.value === '::global') {
                            item.replaceWith(...childSel.nodes);
                        } else if (part.value === '::local') {
                            item.replaceWith(
                                scopeHost(scope),
                                selParser.string({ value: ' ' }),
                                ...childSel.nodes
                            );
                        }

                        innerReplacements.push(sel);
                    }

                    replacements.splice(i, 1, ...innerReplacements);
                }
            }
        }

        sel.replaceWith(...replacements);
    }
}

/**
 * Scopes given CSS selector fragment, if possible.
 * Returns either rewritten or the same node
 */
function rewriteSelectorPart(selector: Selector, item: Node, scope: string): void {
    if (item[processed]) {
        return;
    }

    if (item.type === 'pseudo') {
        if (item.value === ':host') {
            item.replaceWith(scopeHost(scope), ...item.nodes);
        } else if (item.value === ':host-context') {
            item.replaceWith(
                ...item.nodes,
                selParser.string({ value: ' ' }),
                scopeHost(scope)
            );
        }
    } else if (item.type === 'tag' || item.type === 'universal') {
        insertAfter(selector, item, scopeElement(scope));
    } else if (item.type === 'id' || item.type === 'class' || item.type === 'attribute') {
        insertBefore(selector, item, scopeElement(scope));
    }
}

function rewriteSlotted(selector: Selector, scope: string): boolean {
    const node = selector.first;
    if (node?.type === 'pseudo' && node.value === '::slotted') {
        node.replaceWith(
            selParser.tag({ value: 'slot' }),
            selParser.attribute({ attribute: 'slotted' } as any),
            scopeElement(scope),
            selParser.combinator({ value: ' > ' }),
            ...node.nodes
        );

        return true;
    }

    return false;
}

function rewriteRefs(selector: Selector, scope: string) {
    selector.walkTags(node => {
        if (node.value === 'ref') {
            const next = node.next();
            if (next?.type === 'pseudo') {
                const refName = next.value.slice(1);
                const attr = selParser.attribute({ attribute: `ref-${refName}-${scope}`} as any);
                markProcessed(attr);
                next.remove();
                node.replaceWith(attr);
            }
        }
    });
}

function insertBefore(selector: Selector, oldNode: SelectorChild, newNode: SelectorChild): void {
    newNode.spaces.before = oldNode.spaces.before;
    oldNode.spaces.before = '';
    selector.insertBefore(oldNode, newNode);
}

function insertAfter(selector: Selector, oldNode: SelectorChild, newNode: SelectorChild): void {
    newNode.spaces.after = oldNode.spaces.after;
    oldNode.spaces.after = '';
    selector.insertAfter(oldNode, newNode);
}

/**
 * Returns array of selector list items where compound selectors starts
 */
function getCompound(sel: Selector): Node[] {
    const result: Node[] = [];
    let part: Node | null = null;

    sel.nodes.forEach(node => {
        if (isCompoundBoundary(node)) {
            part = null;
        } else if (!part) {
            result.push(part = node);
        }
    });

    return result;
}

/**
 * Check if given node is a compound selector boundary
 */
function isCompoundBoundary(node: Node): boolean {
    return node.type === 'combinator';
}

function scopeElement(scope: string): Attribute {
    return selParser.attribute({ attribute: scope } as any);
}

function scopeHost(scope: string): Attribute {
    return selParser.attribute({ attribute: `${scope}-host` } as any);
}

function markProcessed<T>(item: T | T[]) {
    if (Array.isArray(item)) {
        item.forEach(t => t[processed] = true);
    } else {
        item[processed]= true;
    }
}

function isKeyframe(node: PostCSSContainer<ChildNode>): node is AtRule {
    return node.type === 'atrule' && cssName((node as AtRule).name) === 'keyframes';
}

function getMediaScope(node: PostCSSContainer<ChildNode>): string  | undefined {
    if (node.type === 'atrule') {
        const m = (node as AtRule).params.match(/\b(local|global)\b/);
        return m?.[1];
    }
}

/**
 * Concatenates two strings with optional separator
 */
function concat(name: string, suffix: string) {
    const sep = suffix[0] === '_' || suffix[0] === '-' ? '' : '-';
    return name + sep + suffix;
}

/**
 * Returns clean CSS name: removes any vendor prefixes from given name
 */
function cssName(propName: string): string {
    return (propName || '').replace(/^-\w+-/, '');
}

function isRewriteableKeyframe(atrule: AtRule): boolean {
    return isKeyframe(atrule) && (!atrule.parent || getMediaScope(atrule.parent) !== 'global');
}

function scopeClassNames<T extends Container>(sel: T, options: ClassScopeOptions, force?: boolean): T {
    if (options.prefix || options.suffix) {
        for (const node of sel.nodes) {
            if (shouldScopeNode(node, options)) {
                scopeValue(node, options);
            } else if ('nodes' in node && (force || !isIgnoredPseudo(node))) {
                for (const child of node.nodes) {
                    scopeClassNames(child as T, options);
                }
            }
        }
    }

    return sel;
}

function scopeClassNamesInContainer<T extends Container>(container: T, options: ClassScopeOptions): T[] {
    if (!options.full) {
        // No need to create every possible combination of selector.
        // But we should check whether should be rewritten at all.
        let shouldUpdate = false;
        container.walkClasses(node => {
            if (shouldScopeNode(node, options)) {
                shouldUpdate = true;
                return false;
            }
        });

        if (!shouldUpdate) {
            return [];
        }

        const copy = container.clone({}) as T;
        return [scopeClassNames(copy, options, true)];
    }

    const toUpdate: T[] = [container];
    container.nodes.forEach((node, i) => {
        if (shouldScopeNode(node, options)) {
            for (let sel of toUpdate.slice()) {
                sel = sel.clone({}) as T;
                scopeValue(sel.at(i), options);
                toUpdate.push(sel);
            }
        } else if (node.type === 'pseudo') {
            // Pseudo-class may contain multiple Selectors
            node.nodes.forEach((pseudoSel, j) => {
                for (let sel of toUpdate.slice()) {
                    for (const u of scopeClassNamesInContainer(pseudoSel, options)) {
                        sel = sel.clone({}) as T;
                        const targetPseudo = sel.at(i) as T;
                        targetPseudo.at(j).replaceWith(u);
                        toUpdate.push(sel);
                    }
                }
            });
        }
    });

    return toUpdate.slice(1);
}

function scopeClassNamesInRule(rule: Rule, options: ClassScopeOptions) {
    const selProcessor = selParser(root => {
        root.each(sel => {
            for (const updated of scopeClassNamesInContainer(sel, options)) {
                root.insertBefore(sel, updated);
            }
        });
    });

    selProcessor.processSync(rule, { updateSelector: true });
}

function scopeValue<T extends Node>(node: T, options: ClassScopeOptions) {
    if (shouldScopeNode(node, options)) {
        node.value = `${options.prefix || ''}${node.value}${options.suffix || ''}`;
    }

    return node;
}

function isIgnoredPseudo(node: Node): boolean {
    return node.type === 'pseudo' && ignoreClassScopingPseudo.has(node.value);
}

function shouldScopeNode(node: Node, options: ClassScopeOptions) {
    if (node.type !== 'class') {
        return false;
    }
    const { include, exclude } = options;
    const { value } = node;
    return !exclude?.test(value) && (!include || include.test(value));
}

function isGlobalClassScope(options: boolean | ClassScopeOptions): options is ClassScopeOptions {
    if (options && typeof options !== 'boolean') {
        return !!options.suffix || !!options.prefix;
    }

    return false;
}

function getClassScopeOptions(scope: string, classScope: boolean | ClassScopeOptions): ClassScopeOptions | undefined {
    if (classScope) {
        const opt: ClassScopeOptions = {};
        if (typeof classScope !== 'boolean') {
            Object.assign(opt, classScope);
        }

        if (!opt.prefix && !opt.suffix && scope) {
            opt.suffix = `_${scope}`;
        }

        return opt;
    }
}
