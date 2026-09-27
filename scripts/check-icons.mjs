#!/usr/bin/env node
/**
 * check-icons.mjs — 主屏图标必须齐、必须不透明
 *
 * 存在理由：iOS 唯一的分发路径是"添加到主屏幕"（B3/E4 定案），
 * 图标缺失时 iOS 退化成网页截图、Android 装不上 PWA，
 * 而这两件事在浏览器里都不报错 —— 属于"错了也没人知道"的那类。
 * 期望清单直接从生成物与 HTML 的引用里读，不另立一份，避免两处漂移。
 *
 * 用法：node scripts/check-icons.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'web', 'public');

/** PNG 头部：签名 8 字节 + IHDR(长度4 + 类型4 + 宽4 + 高4 + 位深1 + 颜色类型1) */
function pngInfo(file) {
  const b = readFileSync(file);
  if (b.length < 26 || b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    return { error: '不是有效的 PNG' };
  }
  if (b.subarray(12, 16).toString('ascii') !== 'IHDR') return { error: 'IHDR 不在预期位置' };
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const bitDepth = b[24];
  const colorType = b[25];
  // 颜色类型 6=RGBA、4=带灰度通道、且任何 tRNS 块都意味着可能透明
  const hasTrns = !b.subarray(0, Math.min(b.length, 4096)).includes(Buffer.from('tRNS'));
  const opaque = (colorType === 2 || colorType === 0 || colorType === 3) && hasTrns;
  return { width, height, bitDepth, colorType, opaque, error: null };
}

const problems = [];

// 1) PWA manifest 声明的图标
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
for (const icon of manifest.icons ?? []) {
  const rel = String(icon.src).replace(/^\/+/, '');
  const file = join(PUBLIC, rel);
  if (!existsSync(file)) { problems.push(`manifest 声明了但文件不存在：${rel}`); continue; }
  const info = pngInfo(file);
  if (info.error) { problems.push(`${rel}: ${info.error}`); continue; }
  const declared = String(icon.sizes ?? '').match(/^(\d+)x(\d+)$/);
  if (declared && (info.width !== +declared[1] || info.height !== +declared[2])) {
    problems.push(`${rel}: 声明 ${icon.sizes}，实际 ${info.width}x${info.height}`);
  }
  if (!info.opaque) {
    problems.push(`${rel}: 不是不透明底（colorType=${info.colorType}）—— 圆角遮罩下会出现黑边`);
  }
  const purpose = String(icon.purpose ?? '');
  if (icon.src.includes('maskable') && !purpose.includes('maskable')) {
    problems.push(`${rel}: 文件名是 maskable 但 purpose 没声明 maskable`);
  }
}

// 2) index.html 里引用的 iOS 主屏图标
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const appleRefs = [...html.matchAll(/apple-touch-icon[^>]*href="%BASE_URL%([^"]+)"/g)].map((m) => m[1]);
if (!appleRefs.length) problems.push('index.html 里没有走 %BASE_URL% 的 apple-touch-icon（写死了？）');
for (const rel of appleRefs) {
  const file = join(PUBLIC, rel);
  if (!existsSync(file)) { problems.push(`apple-touch-icon 引用但不存在：${rel}`); continue; }
  const info = pngInfo(file);
  const size = /(\d+)\.png$/.exec(rel)?.[1];
  if (info.error) { problems.push(`${rel}: ${info.error}`); continue; }
  if (size && String(info.width) !== size) problems.push(`${rel}: 应为 ${size}x${size}，实际 ${info.width}x${info.height}`);
  if (!info.opaque) problems.push(`${rel}: iOS 主屏图标不得带透明通道`);
}

// 3) 任何绝对路径的 public 引用都会绕过 base，换仓库形态即 404
const absolute = [...html.matchAll(/href="(\/(?!\/)[^"]+)"/g)].map((m) => m[1]);
for (const href of absolute) problems.push(`index.html 用了根绝对路径 ${href} —— Pages 挂子路径时必 404，应写 %BASE_URL%`);

if (problems.length) {
  console.error('\n✗ check-icons: 图标有问题\n');
  for (const p of problems) console.error('  - ' + p);
  console.error('\n  iOS 只能走"添加到主屏幕"，图标是这条路上唯一的外观。生成方式：');
  console.error('  ffmpeg -i shared/brand/app-icon-master.png -vf "scale=192:192,format=rgb24" …\n');
  process.exit(1);
}

const total = [...manifest.icons ?? [], ...appleRefs].length;
console.log(`✓ check-icons: ${total} 个图标齐全、尺寸匹配、均为不透明底`);
