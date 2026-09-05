import fs from 'node:fs';
import path from 'node:path';
import type { PersonaConfig } from './types';
import { normalizePersona } from './defaults';
import { packagePath } from '../utils/paths';

const DEFAULT_PERSONA_DIR = packagePath('data', 'personas');

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

/** 从 data/personas/{id}.json 加载人格（校验 + 合并默认值） */
export function loadPersona(personaId: string, dir = DEFAULT_PERSONA_DIR): PersonaConfig {
  return loadPersonaFromFile(path.join(dir, `${personaId}.json`));
}
