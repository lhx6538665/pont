import * as path from 'path';
import * as fs from 'fs-extra';
import * as prettier from 'prettier';

import * as ts from 'typescript';
import { ResolveConfigOptions } from 'prettier';
import { error } from './debugLog';
import { Mod, StandardDataSource } from './standard';
import { Manager } from './manage';
import { OriginType } from './scripts';
import { diff } from './diff';
import { getTemplateByTemplateType } from './templates';

const defaultTemplateCode = `
import * as Pont from 'pont-engine';
import { CodeGenerator, Interface } from "pont-engine";

export class FileStructures extends Pont.FileStructures {
}

export default class MyGenerator extends CodeGenerator {
}
`;

const defaultTransformCode = `
import { StandardDataSource } from "pont-engine";

export default function(dataSource: StandardDataSource): StandardDataSource {
  return dataSource;
}
`;

const defaultFetchMethodCode = `
import fetch from 'node-fetch';

export default function (url: string): string {
  return fetch(url).then(res => res.text())
}
`;

export class Mocks {
  enable = false;
  port = 8080;
  basePath = '';
  wrapper = `{
      "code": 0,
      "data": {response},
      "message": ""
    }`;
}

export enum Surrounding {
  typeScript = 'typeScript',
  javaScript = 'javaScript'
}

export enum SurroundingFileName {
  javaScript = 'js',
  typeScript = 'ts'
}

export class DataSourceConfig {
  originUrl? = '';
  originType = OriginType.SwaggerV2;
  name?: string;
  usingOperationId = true;
  usingMultipleOrigins = false;
  taggedByName = true;
  templatePath = 'serviceTemplate';
  templateType = '';
  surrounding = Surrounding.typeScript;
  outDir = 'src/service';
  transformPath = '';
  fetchMethodPath = '';
  prettierConfig: ResolveConfigOptions = {};
  /** 单位为秒，默认 20 分钟 */
  pollingTime = 60 * 20;
  mocks = new Mocks();

  constructor(config: DataSourceConfig) {
    Object.keys(config).forEach(key => {
      if (key === 'mocks') {
        this[key] = {
          ...this[key],
          ...config[key]
        };
      } else {
        this[key] = config[key];
      }
    });
  }
}

export class Config extends DataSourceConfig {
  originType = OriginType.SwaggerV2;
  origins? = [] as Array<{
    originType: OriginType;
    originUrl: string;
    name: string;
    usingOperationId: boolean;
    transformPath?: string;
    fetchMethodPath?: string;
  }>;
  transformPath: string;
  fetchMethodPath: string;

  constructor(config: Config) {
    super(config);
    this.origins = config.origins || [];
  }

  static getTransformFromConfig(config: Config | DataSourceConfig) {
    if (config.transformPath) {
      const moduleResult = getTemplate(config.transformPath, '', defaultTransformCode) as any;

      if (moduleResult) {
        return moduleResult.default;
      }
    }

    return id => id;
  }

  static getFetchMethodFromConfig(config: Config | DataSourceConfig) {
    if (config.fetchMethodPath) {
      const moduleResult = getTemplate(config.fetchMethodPath, '', defaultFetchMethodCode);

      if (moduleResult) {
        return moduleResult.default;
      }
    }

    return id => id;
  }

  validate() {
    if (this.origins && this.origins.length) {
      this.origins.forEach((origin, index) => {
        if (!origin.originUrl) {
          return `请在 origins[${index}] 中配置 originUrl `;
        }
        if (!origin.name) {
          return `请在 origins[${index}] 中配置 originUrl `;
        }
      });
    } else {
      if (!this.originUrl) {
        return '请配置 originUrl 来指定远程地址。';
      }
    }

    return '';
  }

  static createFromConfigPath(configPath: string) {
    const content = fs.readFileSync(configPath, 'utf8');

    try {
      const configObj = JSON.parse(content);

      return new Config(configObj);
    } catch (e) {
      throw new Error('pont-config.json is not a validate json');
    }
  }

  getDataSourcesConfig(configDir: string) {
    const { origins, ...rest } = this;
    const commonConfig = {
      ...rest,
      outDir: path.join(configDir, this.outDir),
      templatePath: this.templatePath ? path.join(configDir, this.templatePath) : undefined,
      transformPath: this.transformPath ? path.join(configDir, this.transformPath) : undefined,
      fetchMethodPath: this.fetchMethodPath ? path.join(configDir, this.fetchMethodPath) : undefined
    };

    // FIXME: origins中配的路径没有转换成绝对路径，找不到该模块
    if (this.origins && this.origins.length) {
      return this.origins.map(origin => {
        return new DataSourceConfig({
          ...commonConfig,
          ...origin
        });
      });
    }

    return [new DataSourceConfig(commonConfig)];
  }
}

export function format(fileContent: string, prettierOpts = {}) {
  try {
    return prettier.format(fileContent, {
      parser: 'typescript',
      trailingComma: 'all',
      singleQuote: true,
      ...prettierOpts
    });
  } catch (e) {
    error(`代码格式化报错！${e.toString()}\n代码为：${fileContent}`);
    return fileContent;
  }
}

export function getDuplicateById<T>(arr: T[], idKey = 'name'): null | T {
  if (!arr || !arr.length) {
    return null;
  }

  let result;

  arr.forEach((item, itemIndex) => {
    if (arr.slice(0, itemIndex).find(o => o[idKey] === item[idKey])) {
      result = item;
      return;
    }
  });

  return result;
}

export function transformModsName(mods: Mod[]) {
  // 检测所有接口是否存在接口名忽略大小写时重复，如果重复，以下划线命名
  mods.forEach(mod => {
    const currName = mod.name;
    const sameMods = mods.filter(mod => mod.name.toLowerCase() === currName.toLowerCase());

    if (sameMods.length > 1) {
      mod.name = transformDashCase(mod.name);
    }
  });
}

function transformDashCase(name: string) {
  return name.replace(/[A-Z]/g, ch => '_' + ch.toLowerCase());
}

export function transformCamelCase(name: string) {
  let words = [] as string[];
  let result = '';

  if (name.includes('-')) {
    words = name.split('-');
  } else if (name.includes(' ')) {
    words = name.split(' ');
  } else {
    if (typeof name === 'string') {
      result = name;
    } else {
      throw new Error('mod name is not a string: ' + name);
    }
  }

  if (words && words.length) {
    result = words
      .map(word => {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join('');
  }

  result = result.charAt(0).toLowerCase() + result.slice(1);

  if (result.endsWith('Controller')) {
    result = result.slice(0, result.length - 'Controller'.length);
  }

  return result;
}

export function transformDescription(description: string) {
  const words = description.split(' ').filter(word => word !== 'Controller');

  const [firstWord, ...rest] = words;
  const sFirstWord = firstWord.charAt(0).toLowerCase() + firstWord.slice(1);

  return [sFirstWord, ...rest].join('');
}

export function toUpperFirstLetter(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function getMaxSamePath(paths: string[], samePath = '') {
  if (!paths.length) {
    return samePath;
  }

  if (paths.some(path => !path.includes('/'))) {
    return samePath;
  }

  const segs = paths.map(path => {
    const [firstSeg, ...restSegs] = path.split('/');
    return { firstSeg, restSegs };
  });

  if (segs.every((seg, index) => index === 0 || seg.firstSeg === segs[index - 1].firstSeg)) {
    return getMaxSamePath(
      segs.map(seg => seg.restSegs.join('/')),
      samePath + '/' + segs[0].firstSeg
    );
  }

  return samePath;
}

export function getIdentifierFromUrl(url: string, requestType: string, samePath = '') {
  const currUrl = url.slice(samePath.length).match(/([^\.]+)/)[0];

  return (
    requestType +
    currUrl
      .split('/')
      .map(str => {
        if (str.includes('-')) {
          str = str.replace(/(\-\w)+/g, (_match, p1) => {
            if (p1) {
              return p1.slice(1).toUpperCase();
            }
          });
        }

        if (str.match(/^{.+}$/gim)) {
          return 'By' + toUpperFirstLetter(str.slice(1, str.length - 1));
        }
        return toUpperFirstLetter(str);
      })
      .join('')
  );
}

/** some reversed keyword in js but not in java */
const TS_KEYWORDS = ['delete', 'export', 'import', 'new', 'function'];
const REPLACE_WORDS = ['remove', 'exporting', 'importing', 'create', 'functionLoad'];

export function getIdentifierFromOperatorId(operationId: string) {
  const identifier = operationId.replace(/(.+)(Using.+)/, '$1');

  const index = TS_KEYWORDS.indexOf(identifier);

  if (index === -1) {
    return identifier;
  }

  return REPLACE_WORDS[index];
}

export function getTemplate(templatePath, templateType, defaultValue = defaultTemplateCode) {
  if (!fs.existsSync(templatePath + '.ts')) {
    fs.writeFileSync(templatePath + '.ts', getTemplateByTemplateType(templateType) || defaultValue);
  }
  const tsResult = fs.readFileSync(templatePath + '.ts', 'utf8');
  const jsResult = ts.transpileModule(tsResult, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2015,
      module: ts.ModuleKind.CommonJS
    }
  });

  const noCacheFix = (Math.random() + '').slice(2, 5);
  const jsName = templatePath + noCacheFix + '.js';
  let moduleResult;

  try {
    // 编译到js
    fs.writeFileSync(jsName, jsResult.outputText, 'utf8');

    // 用 node require 引用编译后的 js 代码
    moduleResult = require(jsName);

    // 删除该文件
    fs.removeSync(jsName);
  } catch (e) {
    // 删除失败，则再删除
    if (fs.existsSync(jsName)) {
      fs.removeSync(jsName);
    }

    // 没有引用，报错
    if (!moduleResult) {
      throw new Error(e);
    }
  }

  return moduleResult;
}

export function getTemplatesDirFile(fileName, filePath = 'templates/') {
  return fs.readFileSync(__dirname.substring(0, __dirname.lastIndexOf('lib')) + filePath + fileName, 'utf8');
}

export function judgeTemplatesDirFileExists(fileName, filePath = 'templates/') {
  return fs.existsSync(__dirname.substring(0, __dirname.lastIndexOf('lib')) + filePath + fileName);
}

export async function lookForFiles(dir: string, fileName: string): Promise<string> {
  const files = await fs.readdir(dir);

  for (let file of files) {
    const currName = path.join(dir, file);

    const info = await fs.lstat(currName);
    if (info.isDirectory()) {
      if (file === '.git' || file === 'node_modules') {
        continue;
      }

      const result = await lookForFiles(currName, fileName);

      if (result) {
        return result;
      }
    } else if (info.isFile() && file === fileName) {
      return currName;
    }
  }
}

export function toDashCase(name: string) {
  const dashName = name
    .split(' ')
    .join('')
    .replace(/[A-Z]/g, p => '-' + p.toLowerCase());

  if (dashName.startsWith('-')) {
    return dashName.slice(1);
  }

  return dashName;
}

export function toDashDefaultCase(name: string) {
  let dashName = name
    .split(' ')
    .join('')
    .replace(/[A-Z]/g, p => '-' + p.toLowerCase());

  if (dashName.startsWith('-')) {
    dashName = dashName.slice(1);
  }

  if (dashName.endsWith('-controller')) {
    return dashName.slice(0, dashName.length - '-controller'.length);
  }

  return dashName;
}

/** 正则检测是否包含中文名 */
export function hasChinese(str: string) {
  return (
    str &&
    str.match(
      /[\u4E00-\u9FCC\u3400-\u4DB5\uFA0E\uFA0F\uFA11\uFA13\uFA14\uFA1F\uFA21\uFA23\uFA24\uff1a\uff0c\uFA27-\uFA29]|[\ud840-\ud868][\udc00-\udfff]|\ud869[\udc00-\uded6\udf00-\udfff]|[\ud86a-\ud86c][\udc00-\udfff]|\ud86d[\udc00-\udf34\udf40-\udfff]|\ud86e[\udc00-\udc1d]|[\uff01-\uff5e\u3000-\u3009\u2026]/
    )
  );
}

const PROJECT_ROOT = process.cwd();
export const CONFIG_FILE = 'pont-config.json';

export async function createManager(configFile = CONFIG_FILE) {
  const configPath = await lookForFiles(PROJECT_ROOT, configFile);

  if (!configPath) {
    return;
  }

  const config = Config.createFromConfigPath(configPath);
  const manager = new Manager(PROJECT_ROOT, config, path.dirname(configPath));

  await manager.ready();

  return manager;
}

export function diffDses(ds1: StandardDataSource, ds2: StandardDataSource) {
  const mapModel = model => Object.assign({}, model, { details: [] }) as any;

  const modDiffs = diff(ds1.mods.map(mapModel), ds2.mods.map(mapModel));
  const boDiffs = diff(ds1.baseClasses.map(mapModel), ds2.baseClasses.map(mapModel));

  return {
    modDiffs,
    boDiffs
  };
}

export function reviseModName(modName: string) {
  // .replace(/\//g, '.').replace(/^\./, '').replace(/\./g, '_') 转换 / .为下划线
  // exp: /api/v1/users  => api_v1_users
  // exp: api.v1.users => api_v1_users
  return modName
    .replace(/\//g, '.')
    .replace(/^\./, '')
    .replace(/\./g, '_');
}

/** 获取文件名名称 */
export function getFileName(fileName: string, surrounding: string) {
  const isInvalidSurrounding = Surrounding[surrounding];

  if (isInvalidSurrounding) {
    return `${fileName}.${SurroundingFileName[isInvalidSurrounding]}`;
  }

  return `${fileName}.ts`;
}

/** 检测是否是合法url */
export function judgeIsVaildUrl(url: string) {
  return /^(http|https):.*?$/.test(url);
}
