import { svnEnv } from '../src/core/svnCli';

// 集成测试会直接调用 svn；统一继承产品子进程的环境，避免宿主 locale
// 改变日志、info 字段与路径编码，导致与真实命令层不同源的误报。
Object.assign(process.env, svnEnv());
