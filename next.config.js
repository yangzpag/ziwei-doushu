/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['lunar-javascript'],
  output: 'standalone', // Docker 部署用，仅输出运行所需产物
};

module.exports = nextConfig;
