import type { Metadata } from 'next';
import KbSearch from '@/components/kb/KbSearch';

export const metadata: Metadata = {
  title: '中医知识库 · 语义段落检索',
  description: '按语义段落检索倪海厦《人纪》讲课内容，回答带引用，可跳转视频原位置。',
};

export default function KbPage() {
  return <KbSearch />;
}
