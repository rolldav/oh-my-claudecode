/**
 * Notification Configuration Reader
 *
 * Reads notification config from .omc-config.json and provides
 * backward compatibility with the old stopHookCallbacks format.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getClaudeConfigDir } from '../utils/paths.js';
import type {
  NotificationConfig,
  NotificationEvent,
  NotificationPlatform,
  EventNotificationConfig,
  DiscordNotificationConfig,
  DiscordBotNotificationConfig,
  TelegramNotificationConfig,
} from './types.js';

const CONFIG_FILE = join(getClaudeConfigDir(), '.omc-config.json');

/**
 * Read raw config from .omc-config.json
 */
function readRawConfig(): Record<string, unknown> | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Migrate old stopHookCallbacks config to new notification format.
 * This provides backward compatibility for existing users.
 */
function migrateStopHookCallbacks(raw: Record<string, unknown>): NotificationConfig | null {
  const callbacks = raw.stopHookCallbacks as Record<string, unknown> | undefined;
  if (!callbacks) return null;

  const config: NotificationConfig = {
    enabled: true,
    events: {
      'session-end': { enabled: true },
    },
  };

  // Migrate Telegram config
  const telegram = callbacks.telegram as Record<string, unknown> | undefined;
  if (telegram?.enabled) {
    const telegramConfig: TelegramNotificationConfig = {
      enabled: true,
      botToken: (telegram.botToken as string) || '',
      chatId: (telegram.chatId as string) || '',
    };
    config.telegram = telegramConfig;
  }

  // Migrate Discord config
  const discord = callbacks.discord as Record<string, unknown> | undefined;
  if (discord?.enabled) {
    const discordConfig: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: (discord.webhookUrl as string) || '',
    };
    config.discord = discordConfig;
  }

  return config;
}

/**
 * Build notification config from environment variables.
 * This enables zero-config notification setup - just set env vars in .zshrc.
 */
function buildConfigFromEnv(): NotificationConfig | null {
  const config: NotificationConfig = { enabled: false };
  let hasAnyPlatform = false;

  // Discord Bot (token + channel)
  const discordBotToken = process.env.OMC_DISCORD_NOTIFIER_BOT_TOKEN;
  const discordChannel = process.env.OMC_DISCORD_NOTIFIER_CHANNEL;
  if (discordBotToken && discordChannel) {
    config['discord-bot'] = {
      enabled: true,
      botToken: discordBotToken,
      channelId: discordChannel,
    };
    hasAnyPlatform = true;
  }

  // Discord Webhook
  const discordWebhook = process.env.OMC_DISCORD_WEBHOOK_URL;
  if (discordWebhook) {
    config.discord = {
      enabled: true,
      webhookUrl: discordWebhook,
    };
    hasAnyPlatform = true;
  }

  // Telegram (support both OMC_TELEGRAM_BOT_TOKEN and OMC_TELEGRAM_NOTIFIER_BOT_TOKEN)
  const telegramToken = process.env.OMC_TELEGRAM_BOT_TOKEN || process.env.OMC_TELEGRAM_NOTIFIER_BOT_TOKEN;
  const telegramChatId = process.env.OMC_TELEGRAM_CHAT_ID || process.env.OMC_TELEGRAM_NOTIFIER_CHAT_ID || process.env.OMC_TELEGRAM_NOTIFIER_UID;
  if (telegramToken && telegramChatId) {
    config.telegram = {
      enabled: true,
      botToken: telegramToken,
      chatId: telegramChatId,
    };
    hasAnyPlatform = true;
  }

  // Slack
  const slackWebhook = process.env.OMC_SLACK_WEBHOOK_URL;
  if (slackWebhook) {
    config.slack = {
      enabled: true,
      webhookUrl: slackWebhook,
    };
    hasAnyPlatform = true;
  }

  if (!hasAnyPlatform) return null;

  config.enabled = true;
  return config;
}

/**
 * Get the notification configuration.
 *
 * Reads from .omc-config.json, looking for the `notifications` key.
 * Falls back to migrating old `stopHookCallbacks` if present.
 * Returns null if no notification config is found.
 */
export function getNotificationConfig(): NotificationConfig | null {
  const raw = readRawConfig();

  // Priority 1: Explicit notifications config in .omc-config.json
  if (raw) {
    const notifications = raw.notifications as NotificationConfig | undefined;
    if (notifications) {
      if (typeof notifications.enabled !== 'boolean') {
        return null;
      }
      return notifications;
    }
  }

  // Priority 2: Environment variables (zero-config)
  const envConfig = buildConfigFromEnv();
  if (envConfig) return envConfig;

  // Priority 3: Legacy stopHookCallbacks migration
  if (raw) {
    return migrateStopHookCallbacks(raw);
  }

  return null;
}

/**
 * Check if a specific event has any enabled platform.
 */
export function isEventEnabled(config: NotificationConfig, event: NotificationEvent): boolean {
  if (!config.enabled) return false;

  const eventConfig = config.events?.[event];

  // If event is explicitly disabled
  if (eventConfig && eventConfig.enabled === false) return false;

  // If event has no specific config, check if any top-level platform is enabled
  if (!eventConfig) {
    return !!(
      config.discord?.enabled ||
      config['discord-bot']?.enabled ||
      config.telegram?.enabled ||
      config.slack?.enabled ||
      config.webhook?.enabled
    );
  }

  // Check event-specific platform overrides
  if (
    eventConfig.discord?.enabled ||
    eventConfig['discord-bot']?.enabled ||
    eventConfig.telegram?.enabled ||
    eventConfig.slack?.enabled ||
    eventConfig.webhook?.enabled
  ) {
    return true;
  }

  // Fall back to top-level platforms
  return !!(
    config.discord?.enabled ||
    config['discord-bot']?.enabled ||
    config.telegram?.enabled ||
    config.slack?.enabled ||
    config.webhook?.enabled
  );
}

/**
 * Get list of enabled platforms for an event.
 */
export function getEnabledPlatforms(
  config: NotificationConfig,
  event: NotificationEvent
): NotificationPlatform[] {
  if (!config.enabled) return [];

  const platforms: NotificationPlatform[] = [];
  const eventConfig = config.events?.[event];

  // If event is explicitly disabled
  if (eventConfig && eventConfig.enabled === false) return [];

  const checkPlatform = (platform: NotificationPlatform) => {
    const eventPlatform = eventConfig?.[platform as keyof EventNotificationConfig];
    if (eventPlatform && typeof eventPlatform === 'object' && 'enabled' in eventPlatform) {
      if ((eventPlatform as { enabled: boolean }).enabled) {
        platforms.push(platform);
      }
      return; // Event-level config overrides top-level
    }

    // Top-level default
    const topLevel = config[platform as keyof NotificationConfig];
    if (topLevel && typeof topLevel === 'object' && 'enabled' in topLevel && (topLevel as { enabled: boolean }).enabled) {
      platforms.push(platform);
    }
  };

  checkPlatform('discord');
  checkPlatform('discord-bot');
  checkPlatform('telegram');
  checkPlatform('slack');
  checkPlatform('webhook');

  return platforms;
}
