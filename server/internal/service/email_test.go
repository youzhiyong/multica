package service

import "testing"

func TestEmailServiceConfigured(t *testing.T) {
	t.Setenv("RESEND_API_KEY", "")
	if NewEmailService().Configured() {
		t.Fatal("expected email delivery to be unconfigured without RESEND_API_KEY")
	}

	t.Setenv("RESEND_API_KEY", "re_test_key")
	if !NewEmailService().Configured() {
		t.Fatal("expected email delivery to be configured with RESEND_API_KEY")
	}
}

func TestSendVerificationCodeWithoutProviderLogsInsteadOfFailing(t *testing.T) {
	t.Setenv("RESEND_API_KEY", "")

	if err := NewEmailService().SendVerificationCode("dev@example.com", "123456"); err != nil {
		t.Fatalf("expected the development fallback to succeed, got %v", err)
	}
}
