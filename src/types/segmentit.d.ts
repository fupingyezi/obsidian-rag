/**
 * segmentit 没有自带类型声明,这里按 dist/cjs/index.js 的实际形状补一份最小声明。
 * 只声明本项目用到的部分:Segment / useDefault。
 *
 * 为什么用它:SQLite FTS5 默认分词器切不了中文 ——
 * 它对中文会把整句当成一个 token,关键词那一路等于没有。
 * 绕法①是入库前自己分词(用 segmentit),效果最好,代价是加载词典较慢
 * (首次初始化约 1~2 秒,store.ts 里做了懒加载)。
 *
 * ⚠️ 运行时真相:该包两个入口的导出形态不同:
 *   - CJS 入口(main 字段,原生 node ESM 走这里):module.exports 是
 *     require('./segmentit.js') 的间接导出,cjs-module-lexer 检测不到
 *     命名导出 —— 只有 default 可用,`import { Segment }` 运行时炸掉
 *   - ESM 入口(module 字段,tsx/打包器走这里):只有命名导出,没有 default
 * 所以这里两种都声明,使用时用 default ?? 命名空间 兜底兼容:
 *
 *   import * as segmentit from 'segmentit';
 *   const { Segment, useDefault } = segmentit.default ?? segmentit;
 */
declare module 'segmentit' {
  /** 分词结果项:w 是词文本,p 是词性编号(本项目用不到词性) */
  export interface SegWord {
    w: string;
    p: number;
  }

  export class Segment {
    /** 挂载分词模块(内部 useDefault 已配好,不直接调用) */
    use(modules: unknown): this;
    /** 加载词典(useDefault 已配好盘古词典等) */
    loadDict(dicts: unknown[]): this;
    /** 加载同义词词典 */
    loadSynonymDict(dicts: unknown[]): this;
    /** 加载停用词词典 */
    loadStopwordDict(dicts: unknown[]): this;
    /**
     * 分词主入口。
     * stripPunctuation: true 时过滤标点符号 —— FTS 索引里不需要标点。
     */
    doSegment(text: string, options?: { stripPunctuation?: boolean }): SegWord[];
  }

  /** 用默认模块 + 盘古词典初始化一个现成的 Segment 实例 */
  export function useDefault(segment: Segment): Segment;

  /** CJS 入口 module.exports 的形状(见文件头 ⚠️ 说明) */
  const segmentitCjs: {
    Segment: typeof Segment;
    useDefault: typeof useDefault;
  };
  export default segmentitCjs;
}
