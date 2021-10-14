import fs from 'fs';
import path from 'path';
import { strictEqual } from 'assert';
import postcss from 'postcss';
import plugin from '../src';

const processor = postcss(plugin('abc123'));

function process(css: string): string {
    return processor.process(css).css;
}

function read(fileName: string): string {
    return fs.readFileSync(path.resolve(__dirname, fileName), 'utf-8');
}

describe('Rewrite selector', () => {
    it('full css', () => {
        const input = read('./fixtures/input.css');
        const output = read('./fixtures/output.css');
        const processed = process(input);
        strictEqual(processed, output);
    });
});
