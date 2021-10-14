import selParser from 'postcss-selector-parser';
import type { Selector, Attribute, Pseudo, Node } from 'postcss-selector-parser';
import type { Plugin, AtRule, ChildNode, Container, Root } from 'postcss';

type Diff<T, U> = T extends U ? never : T;
type SelectorChild = Diff<Node, Selector>;

export type GetScope = (root: Root) => string | undefined;

const processed = Symbol('processed');

export default function createPlugin(getScope: GetScope | string): Plugin {
    const animations = new Set<string>();
    let scope: string | undefined;

    const selProcessor = selParser(root => {
        root.each(sel => {
            rewriteRefs(sel, scope);
            rewriteSlotted(sel, scope) || rewriteSelector(sel, scope);
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
            scope = typeof getScope === 'function' ? getScope(root) : getScope;

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

function isKeyframe(node: Container<ChildNode>): node is AtRule {
    return node.type === 'atrule' && cssName((node as AtRule).name) === 'keyframes';
}

function getMediaScope(node: Container<ChildNode>): string  | undefined {
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
