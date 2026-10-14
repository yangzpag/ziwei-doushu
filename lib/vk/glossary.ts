/**
 * 术语词表：加载 / 匹配 / 待复核标记。
 *
 * 文件格式（每行一个术语）：
 *   苍术                确定术语
 *   葶苈~               不确定（ASR 存疑），命中时打 reviewFlag，不自动改写
 *   # 开头为注释
 *
 * 匹配规则：长词优先、不重叠；不做任何自动纠正——存疑词只标记待复核。
 */
import fs from 'node:fs';

export interface GlossaryTerm {
  term: string;
  certainty: 'certain' | 'uncertain';
}

export interface TermMatch {
  term: string;
  certainty: GlossaryTerm['certainty'];
  start: number;
  end: number;
}

export class Glossary {
  readonly terms: GlossaryTerm[];

  constructor(terms: GlossaryTerm[]) {
    // 长词优先，保证「附子汤」先于「附子」命中
    this.terms = [...terms].sort((a, b) => b.term.length - a.term.length);
  }

  static fromFile(path: string): Glossary {
    const content = fs.readFileSync(path, 'utf8');
    return Glossary.fromText(content);
  }

  static fromText(content: string): Glossary {
    const terms: GlossaryTerm[] = [];
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const uncertain = line.endsWith('~');
      const term = (uncertain ? line.slice(0, -1) : line).trim();
      if (term.length >= 2) terms.push({ term, certainty: uncertain ? 'uncertain' : 'certain' });
    }
    return new Glossary(terms);
  }

  /** 全文匹配（长词优先、不重叠） */
  match(text: string): TermMatch[] {
    const matches: TermMatch[] = [];
    const taken: boolean[] = new Array(text.length).fill(false);
    for (const { term, certainty } of this.terms) {
      let from = 0;
      for (;;) {
        const idx = text.indexOf(term, from);
        if (idx === -1) break;
        const end = idx + term.length;
        let overlaps = false;
        for (let i = idx; i < end; i++) {
          if (taken[i]) {
            overlaps = true;
            break;
          }
        }
        if (!overlaps) {
          for (let i = idx; i < end; i++) taken[i] = true;
          matches.push({ term, certainty, start: idx, end });
        }
        from = idx + 1;
      }
    }
    return matches.sort((a, b) => a.start - b.start);
  }
}
