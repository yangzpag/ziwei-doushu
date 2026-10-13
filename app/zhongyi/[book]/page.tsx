import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import CourseChat from '@/components/zhongyi/CourseChat';
import { BOOKS, bookMeta } from '@/lib/corpus/books';

export function generateStaticParams() {
  return BOOKS.map((b) => ({ book: b.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ book: string }> }): Promise<Metadata> {
  const { book } = await params;
  const meta = bookMeta(book);
  if (!meta) return { title: '课程不存在 · 中医知识库' };
  return {
    title: `${meta.name} · 倪师判语问答 · 中医知识库`,
    description: `${meta.name}：${meta.desc}每条判语可回放 B 站原视频的那一秒。`,
  };
}

export default async function ZhongyiCoursePage({
  params,
  searchParams,
}: {
  params: Promise<{ book: string }>;
  searchParams: Promise<{ ask?: string }>;
}) {
  const { book } = await params;
  const { ask } = await searchParams;
  if (!bookMeta(book)) notFound();
  return <CourseChat book={book} initialAsk={typeof ask === 'string' ? ask : undefined} />;
}
