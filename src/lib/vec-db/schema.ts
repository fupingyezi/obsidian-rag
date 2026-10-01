/**
 * 四张表的 DDL,集中在这一个文件:「看结构只看这里」。
 * 建表全部 if not exists,幂等,可重复执行。
 *
 *   files       —— 文件级元数据:增量索引的判断依据,path 是 vault 相对路径
 *   chunks      —— 片段本体:正文 + 出处 + 元数据
 *   vec_chunks  —— 向量表(vec0):rowid 与 chunks.id 一一对应,插入时显式
 *                  指定 rowid,删除/回查都靠这个对齐;维度建表时固定,
 *                  与 embedder.dim 必须一致
 *   chunks_fts  —— 关键词表(fts5):存预分词文本(空格分隔),unicode61
 *                  按空白切,预分词后每个中文词就是一个独立 token
 */
export function schemaSql(dim: number): string {
  return `
    create table if not exists files (
      path      text primary key,
      mtime_ms  integer not null,
      size      integer not null,
      hash      text not null               -- 内容 sha256
    );

    create table if not exists chunks (
      id           integer primary key autoincrement,
      file_path    text not null,
      heading_path text not null,
      raw          text not null,
      embed_text   text not null,           -- headingPath + raw,入库时实际被向量化的文本
      line_from    integer not null,
      line_to      integer not null,
      tags         text not null default '[]',  -- JSON 数组字符串
      links        text not null default '[]'
    );
    create index if not exists idx_chunks_file on chunks(file_path);

    create virtual table if not exists vec_chunks using vec0(
      embedding float[${dim}]
    );

    create virtual table if not exists chunks_fts using fts5(
      fts_text,
      heading_path,                        -- 同样存预分词后的标题路径
      tokenize = 'unicode61'
    );
  `;
}
