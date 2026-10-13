import type { Metadata } from 'next';
import KbHome from '@/components/zhongyi/KbHome';

export const metadata = {
  title: '中医知识库 · 倪海厦《人纪》19,294 条判语 · 逐句可回放',
  description:
    '倪海厦《人纪》结构化知识库：伤寒论/金匮要略/神农本草经/黄帝内经/仲景心法/针灸大成六部，19,294 条判语，语义检索，每条精确到秒可回放 B 站原视频。',
  keywords: ['中医知识库', '倪海厦', '人纪', '伤寒论', '金匮要略', '神农本草经', '黄帝内经', '针灸大成'],
};

export default function ZhongyiPage() {
  return <KbHome />;
}
