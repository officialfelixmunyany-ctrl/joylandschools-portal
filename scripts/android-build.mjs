#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const LOCAL_JDK = path.join(ROOT, '.tools', 'jdk-21', 'jdk-21.0.11+10');

const env = { ...process.env };
const localJava = path.join(LOCAL_JDK, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');

if (!env.JAVA_HOME && fs.existsSync(localJava)) {
  env.JAVA_HOME = LOCAL_JDK;
}

if (env.JAVA_HOME) {
  env.PATH = `${path.join(env.JAVA_HOME, 'bin')}${path.delimiter}${env.PATH || ''}`;
}

const command = process.platform === 'win32' ? 'cmd.exe' : './gradlew';
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', '.\\gradlew.bat assembleDebug']
  : ['assembleDebug'];

const child = spawn(command, args, {
  cwd: ANDROID_DIR,
  env,
  stdio: 'inherit'
});

child.on('exit', code => {
  process.exit(code ?? 1);
});
