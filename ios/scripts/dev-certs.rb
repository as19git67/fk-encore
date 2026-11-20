#!/usr/bin/env ruby
# frozen_string_literal: true

# Guard for the TestFlight workflow against piling up Apple Development
# certificates. The workflow imports a fixed one from the secrets; should
# Xcode make a new one anyway (certificate missing, expired or revoked),
# Apple's limit of a few per account would fill up and archives fail.
#
#   dev-certs.rb list   FILE   writes the IDs of the account's development
#                              certificates to FILE (one per line)
#   dev-certs.rb revoke FILE   revokes every development certificate that is
#                              not listed in FILE, i.e. the ones this run made
#
# Uses the App Store Connect API with the key in ASC_KEY_PATH, ASC_KEY_ID and
# ASC_ISSUER_ID. Only Ruby's standard library, which the macOS runner has.

require 'base64'
require 'json'
require 'net/http'
require 'openssl'
require 'uri'

API = 'https://api.appstoreconnect.apple.com/v1'
DEV_TYPES = %w[DEVELOPMENT IOS_DEVELOPMENT].freeze

def b64url(data)
  Base64.urlsafe_encode64(data).delete('=')
end

def token
  key = OpenSSL::PKey::EC.new(File.read(ENV.fetch('ASC_KEY_PATH')))
  header = b64url({ alg: 'ES256', kid: ENV.fetch('ASC_KEY_ID'), typ: 'JWT' }.to_json)
  now = Time.now.to_i
  claims = b64url({ iss: ENV.fetch('ASC_ISSUER_ID'), iat: now, exp: now + 600,
                    aud: 'appstoreconnect-v1' }.to_json)
  input = "#{header}.#{claims}"
  # ES256 wants r and s as two 32-byte numbers, OpenSSL gives DER.
  der = key.sign(OpenSSL::Digest.new('SHA256'), input)
  r, s = OpenSSL::ASN1.decode(der).value.map { |n| n.value.to_s(2).rjust(32, "\0") }
  "#{input}.#{b64url(r + s)}"
end

def request(method, url)
  uri = URI(url)
  req = method.new(uri)
  req['Authorization'] = "Bearer #{token}"
  res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |http| http.request(req) }
  raise "#{method.name.split('::').last} #{uri.path}: HTTP #{res.code} #{res.body}" unless res.is_a?(Net::HTTPSuccess)

  res.body.to_s.empty? ? {} : JSON.parse(res.body)
end

def dev_certs
  url = "#{API}/certificates?filter[certificateType]=#{DEV_TYPES.join(',')}" \
        '&fields[certificates]=name,certificateType,expirationDate&limit=200'
  certs = []
  while url
    page = request(Net::HTTP::Get, url)
    certs.concat(page.fetch('data'))
    url = page.dig('links', 'next')
  end
  certs
end

mode, file = ARGV
abort 'usage: dev-certs.rb list|revoke FILE' unless %w[list revoke].include?(mode) && file

certs = dev_certs
case mode
when 'list'
  File.write(file, certs.map { |c| "#{c['id']}\n" }.join)
  puts "#{certs.size} development certificate(s) before the build."
when 'revoke'
  before = File.exist?(file) ? File.readlines(file, chomp: true) : nil
  abort 'No list from before the build; revoking nothing.' if before.nil?

  made = certs.reject { |c| before.include?(c['id']) }
  made.each do |c|
    request(Net::HTTP::Delete, "#{API}/certificates/#{c['id']}")
    puts "Revoked #{c.dig('attributes', 'name')} (#{c['id']}), made by this run."
  end
  unless made.empty?
    puts '::warning::Xcode made a new development certificate instead of using IOS_DEV_CERT_P12 ' \
         '(it was revoked again). Check that the certificate in the secret is still valid in the ' \
         'developer account (documentation/ios-app.md › TestFlight builds).'
  end
  puts 'No development certificate was made by this run.' if made.empty?
end
