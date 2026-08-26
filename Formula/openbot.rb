# tap: brew tap JWilson45/openbot https://github.com/JWilson45/openbot
# then: brew install openbot
class Openbot < Formula
  desc "Named AI teammates that live on this machine"
  homepage "https://github.com/JWilson45/openbot"
  version "0.3.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/JWilson45/openbot/releases/download/v#{version}/openbot-darwin-arm64"
    else
      url "https://github.com/JWilson45/openbot/releases/download/v#{version}/openbot-darwin-x64"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/JWilson45/openbot/releases/download/v#{version}/openbot-linux-arm64"
    else
      url "https://github.com/JWilson45/openbot/releases/download/v#{version}/openbot-linux-x64"
    end
  end

  sha256 :no_check

  def install
    bin.install Dir["openbot-*"].first => "openbot"
  end

  def caveats
    <<~EOS
      grok must be on PATH; run `grok login` as this user.
      Chromium/Chrome is optional (takeover / browser tools).
      Do not run OpenBot as root.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/openbot version")
  end
end
