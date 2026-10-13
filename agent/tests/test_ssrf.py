import pytest
from app.main import is_safe_ip, validate_url, fetch

def test_is_safe_ip():
    assert not is_safe_ip("127.0.0.1")
    assert not is_safe_ip("::1")
    assert not is_safe_ip("10.0.0.1")
    assert not is_safe_ip("192.168.1.1")
    assert not is_safe_ip("169.254.169.254")
    assert not is_safe_ip("0.0.0.0")
    assert not is_safe_ip("invalid-ip")
    assert is_safe_ip("8.8.8.8")
    assert is_safe_ip("1.1.1.1")

def test_validate_url_schemes():
    assert validate_url("ftp://example.com") is None
    assert validate_url("file:///etc/passwd") is None
    assert validate_url("http://127.0.0.1") is None
    assert validate_url("http://localhost:8000") is None
    assert validate_url("gopher://example.com") is None

def test_fetch_blocked_url():
    assert fetch("http://127.0.0.1:8080/api/v1/readyz") == ("", "")
    assert fetch("http://169.254.169.254/latest/meta-data/") == ("", "")
