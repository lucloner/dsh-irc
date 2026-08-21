'use strict'

/**
 * dsh-autoload — 通用 DSH 动态插件自动加载框架（标准 Cordis Host 插件）
 *
 * 在 DSH 启动后，自动把一组「组件」（每个组件 = 一对 host.js / client.js 源码）
 * 通过 dynamicCordisRunner define() + runHostHalf() 注册为动态 Cordis 插件，
 * 从而免去每次重启后手动 run + 浏览器批准。
 *
 * 组件清单通过 cordis.patch.yml 的 config.components 传入，例如：
 *
 *   - insert:
 *       - id: dsh-autoload
 *         name: '@dsh-mod/dsh-autoload'
 *         inject: ['dynamicCordisRunner']
 *         config:
 *           components:
 *             - id: irc
 *               name: 'IRC Chat Panel'
 *               purpose: '...'
 *               idPrefix: 'irct'
 *               hostFile: '/home/lucloner/src/dsh-irc/plugin/host.js'
 *               clientFile: '/home/lucloner/src/dsh-irc/plugin/client.js'
 *
 * 行为：
 *   - 只为主会话（root agent）创建，子代理（subagent）跳过，避免重复面板。
 *   - 按 session 幂等：同一会话只创建一次，新开的主会话各自拥有自己的面板。
 *   - 用 runHostHalf(requestId=null) 免审批预授权 client 端；浏览器刷新后加载。
 */

const fs = require('fs')

/** 读取组件源码文件，返回去除首尾空白的字符串；失败返回 null。 */
function readSource(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim() } catch (e) {
    console.warn('[dsh-autoload] cannot read', filePath, e.message)
    return null
  }
}

module.exports = {
  inject: ['dynamicCordisRunner', 'agents'],
  apply(ctx, config) {
    const components = Array.isArray(config && config.components) ? config.components : []

    // sessionId -> Set(componentId)：记录每个会话已创建的组件，保证幂等。
    const createdBySession = new Map()

    function loadComponents(agent) {
      const runner = ctx.get('dynamicCordisRunner')
      if (!runner) return // 服务未就绪，等下一次 agent/created

      // 只为主会话创建，跳过子代理。
      const agents = ctx.get('agents')
      if (agents) {
        const isRoot = agents.roots().some(function (a) { return a.id === agent.id })
        if (!isRoot) {
          console.log('[dsh-autoload] skip subagent', agent.id)
          return
        }
      }

      const sessionId = agent.id || agent.sessionId
      if (!sessionId) {
        console.warn('[dsh-autoload] agent has no id or sessionId')
        return
      }

      let created = createdBySession.get(sessionId)
      if (!created) {
        created = new Set()
        createdBySession.set(sessionId, created)
      }

      for (const comp of components) {
        if (created.has(comp.id)) continue

        const hostCode = readSource(comp.hostFile)
        const clientCode = readSource(comp.clientFile)
        if (!hostCode && !clientCode) {
          console.warn('[dsh-autoload] component', comp.id, 'has no readable source')
          continue
        }

        try {
          const result = runner.define({
            sessionId: sessionId,
            name: comp.name,
            purpose: comp.purpose,
            plugin: { kind: 'new', idPrefix: comp.idPrefix },
            code: {
              host: hostCode || undefined,
              client: clientCode || undefined,
            },
          })
          created.add(comp.id)
          runner.runHostHalf(agent, result.pluginId, result.packageId, 'run', null, true)
          console.log('[dsh-autoload] defined', comp.id, result.pluginId, result.packageId)
        } catch (e) {
          if (e.message.includes('already has a pending run request')) continue
          console.error('[dsh-autoload] define failed for', comp.id, e.message)
        }
      }
    }

    // 立即尝试一次（若已有当前 initiator agent）。
    const agents = ctx.get('agents')
    const agent = agents && agents.currentInitiator()
    if (agent) loadComponents(agent)

    // 监听新 agent 创建，用事件 payload 里的 agent。
    ctx.on('agent/created', function (payload) {
      const agent = payload && payload.agent
      if (agent) loadComponents(agent)
    })
  },
}
