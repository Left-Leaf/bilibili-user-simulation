import fs from 'node:fs';
import path from 'node:path';
import type { PersonaConfig } from './types';
import { normalizePersona } from './defaults';
import { packagePath } from '../utils/paths';

const DEFAULT_PERSONA_DIR = packagePath('data', 'personas');

/** 从 data/personas/{id}.json 加载人格（校验 + 合并默认值） */
export function loadPersona(personaId: string, dir = DEFAULT_PERSONA_DIR): PersonaConfig {
  const file = path.join(dir, `${personaId}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Persona 文件不存在: ${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<PersonaConfig>;
  if (!raw.id) {
    raw.id = personaId;
  }
  return normalizePersona(raw);
}
