import { DateTime } from 'luxon';
import type { OrchestratorConfig, ScheduleDay } from '../config/schema.js';
import type { OperationType } from '../types/domain.js';

const dayNames: readonly ScheduleDay[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export interface OperatingHours {
  isOpen: boolean;
  minutesRemaining: number;
  canStart: boolean;
  reason: 'SCHEDULE_DISABLED' | 'OUTSIDE_WINDOW' | 'INSUFFICIENT_REMAINING_TIME' | 'OPEN';
}

export interface ScheduleClock {
  now?: DateTime;
}

function minutesSinceMidnight(value: string): number {
  const parts = value.split(':').map(Number);
  const hours = parts[0];
  const minutes = parts[1];
  if (hours === undefined || minutes === undefined) {
    throw new Error(`Invalid time value: ${value}`);
  }
  return hours * 60 + minutes;
}

function dayName(dateTime: DateTime): ScheduleDay {
  return dayNames[dateTime.weekday - 1] as ScheduleDay;
}

function windowMinutesRemaining(dateTime: DateTime, end: string): number {
  const endMinutes = minutesSinceMidnight(end);
  const currentMinutes = dateTime.hour * 60 + dateTime.minute + dateTime.second / 60;
  return endMinutes > currentMinutes ? endMinutes - currentMinutes : 24 * 60 - currentMinutes + endMinutes;
}

export function operatingHoursFor(
  config: OrchestratorConfig,
  operation: OperationType,
  clock: ScheduleClock = {},
): OperatingHours {
  if (!config.schedule.enabled) {
    return { isOpen: true, minutesRemaining: Number.POSITIVE_INFINITY, canStart: true, reason: 'SCHEDULE_DISABLED' };
  }

  const now = clock.now ?? DateTime.now().setZone(config.timezone);
  const currentDay = config.schedule.days[dayName(now)];
  const previousDay = config.schedule.days[dayName(now.minus({ days: 1 }))];
  const currentMinutes = now.hour * 60 + now.minute + now.second / 60;

  let minutesRemaining = 0;
  let isOpen = false;
  if (currentDay.enabled) {
    for (const window of currentDay.windows) {
      const start = minutesSinceMidnight(window.start);
      const end = minutesSinceMidnight(window.end);
      const overnight = end <= start;
      const active = overnight ? currentMinutes >= start : currentMinutes >= start && currentMinutes < end;
      if (active) {
        isOpen = true;
        minutesRemaining = Math.max(minutesRemaining, windowMinutesRemaining(now, window.end));
      }
    }
  }

  if (!isOpen && previousDay.enabled) {
    for (const window of previousDay.windows) {
      const start = minutesSinceMidnight(window.start);
      const end = minutesSinceMidnight(window.end);
      if (end <= start && currentMinutes < end) {
        isOpen = true;
        minutesRemaining = Math.max(minutesRemaining, currentMinutes === 0 ? end : end - currentMinutes);
      }
    }
  }

  if (!isOpen) {
    return { isOpen: false, minutesRemaining: 0, canStart: false, reason: 'OUTSIDE_WINDOW' };
  }

  const requiredMinutes = minimumMinutesFor(config, operation);
  if (minutesRemaining < requiredMinutes) {
    return { isOpen: true, minutesRemaining, canStart: false, reason: 'INSUFFICIENT_REMAINING_TIME' };
  }

  return { isOpen: true, minutesRemaining, canStart: true, reason: 'OPEN' };
}

function minimumMinutesFor(config: OrchestratorConfig, operation: OperationType): number {
  switch (operation) {
    case 'TASK_DISCOVERY': return config.schedule.minimumRemainingMinutesForNewTask;
    case 'ANALYSIS': return config.schedule.minimumRemainingMinutesForAnalysis;
    case 'IMPLEMENTATION':
    case 'FIX': return config.schedule.minimumRemainingMinutesForImplementation;
    case 'REVIEW': return config.schedule.minimumRemainingMinutesForReview;
    case 'DELIVERY':
    case 'CI_CHECK': return 0;
  }
}
