/**
 * 人格加载：**人格目录 + 文件名（= personaId）**。
 *
 * - `loadPersona(personaId, dir)`：从人格目录按 `{personaId}.json` 加载，加载后人格 id 以文件名为准；
 * - `listPersonas(dir)`：扫描目录下全部 `*.json`，以文件名（去扩展名）作为 personaId；
 * - `loadPersonaFromFile(file)`：直接按路径加载（宿主自定义命名 / 任意位置时用）。
 *
 * 默认目录为**包内** `data/personas`；作为依赖包被主项目导入时，可用 `personaDir` 指向主项目自己的
 * 人格目录（如 `<主项目>/data/personas`），之后直接传 `personaId`（文件名）即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PersonaConfig } from './types';
import { normalizePersona } from './defaults';
import { packagePath } from '../utils/paths';

/** 默认人格目录（包内 `data/personas`；主项目可用 `personaDir` 指向自己的目录） */
export const DEFAULT_PERSONA_DIR = packagePath('data', 'personas');

/** 人格目录中的一条人格（`id` = 文件名去 `.json`） */
export interface PersonaEntry {
  /** personaId（即文件名，不含扩展名） */
  id: string;
  /** 配置文件绝对路径 */
  file: string;
}

/** 从任意 persona JSON 文件加载人格（校验 + 合并默认值）。主项目可传外部人格文件路径。 */
export function loadPersonaFromFile(file: string): PersonaConfig {
  if (!fs.existsSync(file)) {
    throw new Error(`Persona 文件不存在: ${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<PersonaConfig>;
  if (!raw.id) {
    raw.id = path.basename(file, path.extname(file));
  }
  return normalizePersona(raw);
}

/**
 * 列出人格目录下所有人格（`*.json`），**以文件名作为 personaId**。
 * 目录不存在 / 不可读时返回空数组（不抛错，便于宿主探测）。
 */
export function listPersonas(dir?: string): PersonaEntry[] {
  const target = dir ?? DEFAULT_PERSONA_DIR;
  let names: string[];
  try {
    names = fs.readdirSync(target);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.toLowerCase().endsWith('.json'))
    .map((n) => ({ id: path.basename(n, path.extname(n)), file: path.join(target, n) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 按 personaId 从人格目录加载人格（即 `{dir}/{personaId}.json`）。
 *
 * - **personaId 就是文件名**（不含 `.json`）：加载后 `persona.id` 以文件名归一化
 *   （文件内 `id` 字段与文件名不一致时以文件名为准，保证 personaId 唯一且可预测）；
 * - 文件不存在时抛错，并列出该目录下**可用的人格 id**，便于排查。
 */
export function loadPersona(personaId: string, dir?: string): PersonaConfig {
  const target = dir ?? DEFAULT_PERSONA_DIR;
  const file = path.join(target, `${personaId}.json`);
  if (!fs.existsSync(file)) {
    const available = listPersonas(target).map((p) => p.id);
    throw new Error(
      `人格不存在: personaId="${personaId}"（查找路径 ${file}）` +
        (available.length
          ? `；目录下可用人格: ${available.join(', ')}`
          : `；目录 ${target} 中没有任何 .json 人格配置`)
    );
  }
  const persona = loadPersonaFromFile(file);
  persona.id = personaId; // 文件名即 personaId
  return persona;
}
