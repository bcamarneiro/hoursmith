import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }));

vi.mock('../../react/components/ui/Toast', () => ({
	toast: {
		error: toastErrorMock,
		success: vi.fn(),
		info: vi.fn(),
	},
}));

import {
	__resetErrorInterceptorForTests,
	normalizeError,
	reportError,
} from '../errorInterceptor';
import { fromHttpResponse, ServiceError } from '../serviceErrors';

describe('normalizeError', () => {
	it('passes a ServiceError through unchanged', () => {
		const err = fromHttpResponse('Jira search', 401);
		expect(normalizeError(err)).toBe(err);
	});

	it('wraps a plain Error and preserves its message', () => {
		const err = normalizeError(
			new Error('Jira API error: 401 - bad token'),
			'Jira API',
		);
		expect(err).toBeInstanceOf(ServiceError);
		expect(err.message).toBe('Jira API error: 401 - bad token');
		expect(err.source).toBe('Jira API');
	});

	it('sniffs the HTTP status from raw messages so legacy throw sites classify', () => {
		expect(normalizeError(new Error('Jira API error: 401 - body')).kind).toBe(
			'unauthorized',
		);
		expect(normalizeError(new Error('HTTP 403 Forbidden')).kind).toBe(
			'forbidden',
		);
		expect(normalizeError(new Error('server returned 500')).kind).toBe(
			'server-error',
		);
		expect(normalizeError(new Error('boom')).kind).toBe('unknown');
	});

	it('does not sniff version-like numbers (e.g. ISO500)', () => {
		expect(normalizeError(new Error('batch ISO500 failed')).kind).toBe(
			'unknown',
		);
	});

	it('stringifies unknown values', () => {
		const err = normalizeError('plain string');
		expect(err).toBeInstanceOf(ServiceError);
		expect(err.message).toBe('plain string');
	});
});

describe('reportError', () => {
	beforeEach(() => {
		__resetErrorInterceptorForTests();
		toastErrorMock.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('maps a ServiceError to user-facing copy and toasts it', () => {
		const copy = reportError(fromHttpResponse('Jira search', 401));

		expect(copy.message).toContain('Jira rejected your credentials');
		expect(copy.action?.kind).toBe('settings');
		expect(toastErrorMock).toHaveBeenCalledTimes(1);
		expect(toastErrorMock).toHaveBeenCalledWith(copy.message, {
			action: { label: 'Check Settings', onClick: expect.any(Function) },
		});
	});

	it('maps legacy raw errors through the same pipeline', () => {
		const copy = reportError(new Error('Jira API error: 401 - body'));

		expect(copy.message).toContain('Jira rejected your credentials');
		expect(toastErrorMock).toHaveBeenCalledTimes(1);
	});

	it('returns the copy without toasting when silent', () => {
		const copy = reportError(fromHttpResponse('Jira search', 401), {
			silent: true,
		});

		expect(copy.message).toContain('Jira rejected your credentials');
		expect(toastErrorMock).not.toHaveBeenCalled();
	});

	it('uses the fallback message for null errors', () => {
		const copy = reportError(null, { fallbackMessage: 'Clone failed' });

		expect(copy.message).toBe('Clone failed');
		expect(toastErrorMock).toHaveBeenCalledTimes(1);
	});

	it('dedupes identical mapped messages within the window', () => {
		reportError(fromHttpResponse('Jira search', 401));
		reportError(fromHttpResponse('Jira search', 401));
		reportError(fromHttpResponse('Jira activity', 401));

		// All three map to the same copy → one toast.
		expect(toastErrorMock).toHaveBeenCalledTimes(1);
	});

	it('allows the same message again after the dedupe window', () => {
		vi.useFakeTimers();
		reportError(fromHttpResponse('Jira search', 401));

		vi.setSystemTime(Date.now() + 20_000);
		reportError(fromHttpResponse('Jira search', 401));

		expect(toastErrorMock).toHaveBeenCalledTimes(2);
	});

	it('burst-guards distinct errors so a page load of failures shows at most N toasts', () => {
		reportError(fromHttpResponse('Jira search', 401));
		reportError(fromHttpResponse('GitLab', 403));
		reportError(fromHttpResponse('Calendar feed', 404));
		reportError(fromHttpResponse('RescueTime', 500));

		// 4 distinct failures, 3 toasts (MAX_BURST_TOASTS), 4th suppressed.
		expect(toastErrorMock).toHaveBeenCalledTimes(3);
	});

	it('routes the toast action through the app base path', () => {
		const assignSpy = vi
			.spyOn(window.location, 'assign')
			.mockImplementation(() => {});

		try {
			reportError(fromHttpResponse('Jira search', 401));
			const [, options] = toastErrorMock.mock.calls[0] as [
				string,
				{ action?: { onClick: () => void } },
			];
			options.action?.onClick();

			expect(assignSpy).toHaveBeenCalledWith('/settings');
		} finally {
			assignSpy.mockRestore();
		}
	});

	it('handles null errors with a generic message (still toasts)', () => {
		const copy = reportError(null);
		expect(copy.message).not.toBe('');
		expect(toastErrorMock).toHaveBeenCalledTimes(1);
	});
});
