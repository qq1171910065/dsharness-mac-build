import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeManagedBlock, resolveDshHome } from './install.mjs';

/**
 * The deployment patcher's contract.
 *
 * This file is written to a path the official loader reads at **every** boot of
 * every profile, so two properties matter more than anything else:
 *
 * - it must never destroy rows it does not own (the official plugin manager
 *   records user toggles in the same file);
 * - it must be idempotent (running it on every start cannot grow the file).
 *
 * The rows themselves are applied in order with last-write-wins per row id
 * (vendor/include/src/index.ts#applyEntryPatches), which is why appending is
 * semantically sufficient and no YAML parser is required.
 */

const here = dirname(fileURLToPath(import.meta.url));

test('resolveDshHome锛氭樉寮?DSH_HOME 浼樺厛锛屽惁鍒欏洖钀?~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\tmp\\home' }), resolve('C:\\tmp\\home'));
  assert.match(resolveDshHome({}), /[\\/]\.dsh$/);
  // 绌虹櫧鍊肩瓑浜庢病閰嶏紙loader 鐨勫彛寰勶級
  assert.match(resolveDshHome({ DSH_HOME: '   ' }), /[\\/]\.dsh$/);
});

test('绌烘枃浠讹細鐩存帴鍐欏叆鍙楃鍧?, () => {
  const merged = mergeManagedBlock('', '- id: deepseek-account\n  config: {}\n');
  assert.match(merged, /^# >>> dsharness platform rows/);
  assert.match(merged, /- id: deepseek-account/);
  assert.match(merged, /# <<< dsharness platform rows\n$/);
});

test('宸叉湁鐢ㄦ埛琛岋細鍘熸牱淇濈暀锛屽彈绠″潡杩藉姞鍦ㄥ悗闈紙鍚庡啓浼樺厛锛?, () => {
  const existing = '- id: tool-ralph\n  disabled: false\n';
  const merged = mergeManagedBlock(existing, '- id: deepseek-account\n  config: {}\n');
  assert.ok(merged.startsWith(existing.trimEnd()), '鐢ㄦ埛鍐呭蹇呴』閫愬瓧淇濈暀');
  assert.ok(
    merged.indexOf('tool-ralph') < merged.indexOf('dsharness platform rows (managed'),
    '鍙楃鍧楀繀椤诲湪鐢ㄦ埛鍐呭涔嬪悗锛屾墠鑳芥寜銆屽悗鍐欎紭鍏堛€嶈鐩栧悓涓€ id'
  );
});

test('骞傜瓑锛氳繛璺戜袱娆″彧鐣欎竴涓潡锛堟瘡娆″惎鍔ㄩ兘璺戜篃涓嶈兘鑶ㄨ儉锛?, () => {
  const once = mergeManagedBlock('- id: tool-ralph\n  disabled: false\n', '- id: deepseek-account\n  config: {}\n');
  const twice = mergeManagedBlock(once, '- id: deepseek-account\n  config: {}\n');
  assert.equal(twice, once);
  assert.equal(twice.match(/# >>> dsharness platform rows/g)?.length, 1);
  assert.equal(twice.match(/# <<< dsharness platform rows/g)?.length, 1);
});

test('鍙楃鍧楄鎴柇锛堝彧鏈夊紑濮嬫爣璁帮級锛氭暣浣撻噸鍐欙紝涓嶉噸澶嶈拷鍔?, () => {
  const truncated = '# >>> dsharness platform rows (managed by platform/install.mjs)\n- id: deepseek-account\n';
  const merged = mergeManagedBlock(truncated, '- id: deepseek-account\n  config: {}\n');
  assert.equal(merged.match(/# >>> dsharness platform rows/g)?.length, 1);
  assert.equal(merged.match(/# <<< dsharness platform rows/g)?.length, 1);
});

test('鍙楃鍧椾箣鍚庣殑鍐呭涔熶笉鑳戒涪', () => {
  const once = mergeManagedBlock('', '- id: deepseek-account\n  config: {}\n');
  const withTail = ${once}\n- id: tool-ralph\n  disabled: false\n;
  const merged = mergeManagedBlock(withTail, '- id: deepseek-account\n  config: {}\n');
  assert.ok(merged.includes('tool-ralph'), '鍙楃鍧椾箣鍚庣殑琛屽繀椤讳繚鐣?);
  assert.equal(merged.match(/# >>> dsharness platform rows/g)?.length, 1);
});

test('鍙戝竷鐨?cordis.patch.yml锛氬彧瑕嗙洊 deepseek-account锛屼笖涓嶅甫 name 鏂█', () => {
  const text = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
  // 鍙湁涓€涓潪 insert 鐨?patch锛岀洰鏍囨槸瀹樻柟 base 閲岀‘瀹炲瓨鍦ㄧ殑琛?id
  assert.match(text, /^- id: deepseek-account$/m);
  /*
   * 鈿狅笍 name 鍦ㄩ潪 insert 琛ヤ竵閲屾槸**鏂█**锛氬啓閿欎細璁╂暣鏉¤ˉ涓佽闈欓粯璺宠繃
   * 锛坄vendor/include/src/index.ts: name mismatch 鈫?warn + skip锛夈€?   * 涓嶅啓瀹冿紝涓婃父鏀瑰寘鍚嶄篃涓嶄細鎶婃湰閮ㄧ讲鎮勬倓鎵撳洖銆岀櫥褰曡繛 DeepSeek銆嶃€?   */
  assert.ok(!/^\s*name:/m.test(text), '涓嶅緱鍐?name锛氬畠鏄柇瑷€锛屽啓閿欎細闈欓粯璺宠繃鏁存潯琛ヤ竵');
  // 蹇呴』甯︿笂 platformOrigin锛涙湰鍦?http 鍥炵幆杩樿 allowLoopbackHttp
  assert.match(text, /platformOrigin: !!js process\.env\.DSH_PLATFORM_ORIGIN/);
  assert.match(text, /allowLoopbackHttp:/);
  // 鏁村潡 config 蹇呴』鍐欏叏璇ヨ鎷ユ湁鐨勯敭锛堣ˉ涓佹槸鏁村潡鏇挎崲锛屼笉鏄繁鍚堝苟锛?  for (const key of ['desktopPlatform', 'inferenceOrigin', 'requestTimeoutMs', 'attemptTimeoutMs']) {
    assert.match(text, new RegExp(^\\s*${key}:, 'm'), config 蹇呴』閲嶈堪 ${key});
  }
});
