import fs from 'fs';
import path from 'path';
import { strictEqual } from 'assert';
import postcss from 'postcss';
import plugin, { Options } from '../src';

function run(css: string, opt: Options): string {
    const processor = postcss(plugin(opt));
    return processor.process(css).css;
}

function read(fileName: string): string {
    return fs.readFileSync(path.resolve(__dirname, fileName), 'utf-8');
}

describe('Rewrite selector', () => {
    it('full css', () => {
        const input = read('./fixtures/input.css');
        const output = read('./fixtures/output.css');
        const processed = run(input, { scope: 'abc123' });
        strictEqual(processed, output);
    });

    it('scope class names', () => {
        const opt: Options = {
            scope: 'abc321',
            scopeClass: /^js-/
        };

        let result = run(`#a { padding: 1px; }\n.foo.bar > .baz.bam + .bem, #foo.bar { display: block }`, opt);
        strictEqual(result, `[abc321]#a { padding: 1px; }\n[abc321].foo_abc321.bar_abc321 > .baz_abc321.bam_abc321 + [abc321].bem_abc321, [abc321]#foo.bar_abc321 { display: block }`);

        // ignore class names
        result = run(`.foo.js-bar, .js-handle, #foo.js-bar { display: block }`, opt);
        strictEqual(result, `[abc321].foo_abc321.js-bar, [abc321].js-handle, [abc321]#foo.js-bar { display: block }`);

        const input = read('./fixtures/input.css');
        result = run(input, opt);
        strictEqual(result, read('./fixtures/output-scoped.css'));
    });
});
