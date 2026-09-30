'use strict';

/**
 * "Is it really you?" - Windows Hello and Touch ID.
 *
 * macOS: Electron's own systemPreferences.promptTouchID.
 *
 * Windows: Electron has no Windows Hello API, so a tiny helper does it with
 * the system's own UserConsentVerifier, through the interop that parents the
 * Windows Security prompt to Static's window (without a parent it can open
 * behind the browser). The helper is compiled on first use by the C# compiler
 * that ships with every copy of Windows 10 and 11 (.NET Framework 4), from the
 * source below, into Static's data folder. No SDK, no download, no native
 * module to rebuild for each Electron version.
 *
 * Either way this is a GATE, not encryption: it proves someone at this
 * computer passed the operating system's check (face, fingerprint or the
 * Windows Hello PIN). The key it releases is held by the OS for this user.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const SOURCE = `using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Foundation;
using Windows.Security.Credentials.UI;

[ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
public interface IUserConsentVerifierInterop {
  IAsyncOperation<UserConsentVerificationResult> RequestVerificationForWindowAsync(IntPtr appWindow, [MarshalAs(UnmanagedType.HString)] string message, [In] ref Guid riid);
}

public static class StaticHello {
  static T Wait<T>(IAsyncOperation<T> op) {
    while (op.Status == AsyncStatus.Started) System.Threading.Thread.Sleep(25);
    if (op.Status == AsyncStatus.Canceled) throw new OperationCanceledException();
    if (op.Status != AsyncStatus.Completed) throw new Exception("status " + op.Status);
    return op.GetResults();
  }
  public static int Main(string[] args) {
    try {
      if (args.Length > 0 && args[0] == "check") {
        Console.WriteLine(Wait(UserConsentVerifier.CheckAvailabilityAsync()));
        return 0;
      }
      if (args.Length > 2 && args[0] == "verify") {
        string message = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(args[2]));
        var factory = (IUserConsentVerifierInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(UserConsentVerifier));
        Guid iid = typeof(IAsyncOperation<UserConsentVerificationResult>).GUID;
        var op = factory.RequestVerificationForWindowAsync(new IntPtr(long.Parse(args[1])), message, ref iid);
        Console.WriteLine(Wait(op));
        return 0;
      }
      Console.WriteLine("Usage");
      return 2;
    } catch (Exception error) {
      Console.WriteLine("Error " + error.GetType().Name + ": " + error.Message);
      return 1;
    }
  }
}
`;

const LABELS = { darwin: 'Touch ID', win32: 'Windows Hello' };

class Biometric {
  /**
   * @param {string} binDir where the Windows helper is kept
   * @param {() => Electron.BaseWindow|null} getWindow the window to parent the prompt to
   */
  constructor(binDir, getWindow) {
    this.binDir = binDir;
    this.getWindow = getWindow || (() => null);
    this.availability = null;
    // Probes only: stand in for a finger on the sensor, so tests never raise
    // a real Windows Security prompt on someone's screen.
    this.testAnswer = null;
  }

  get label() { return LABELS[process.platform] || 'Device unlock'; }

  /** { available, label, reason } - cached for the session. */
  async check() {
    if (this.testAnswer) return { available: true, label: this.label, reason: null };
    if (this.availability) return this.availability;
    let result = { available: false, label: this.label, reason: 'Not supported on this system.' };
    try {
      if (process.platform === 'darwin') {
        const { systemPreferences } = require('electron');
        const ok = systemPreferences.canPromptTouchID();
        result = { available: ok, label: 'Touch ID', reason: ok ? null : 'Touch ID is not set up on this Mac.' };
      } else if (process.platform === 'win32') {
        const answer = await this.#helper(['check']);
        const ok = answer === 'Available';
        result = {
          available: ok,
          label: 'Windows Hello',
          reason: ok ? null : ({
            DeviceNotPresent: 'This PC has no Windows Hello camera, fingerprint reader or PIN.',
            NotConfiguredForUser: 'Windows Hello is not set up. Add a PIN or fingerprint in Windows Settings > Accounts > Sign-in options.',
            DisabledByPolicy: 'Windows Hello is turned off by your organisation.',
            DeviceBusy: 'Windows Hello is busy. Try again in a moment.',
          }[answer] || 'Windows Hello did not answer (' + answer + ').'),
        };
      }
    } catch (error) {
      result = { available: false, label: this.label, reason: 'Could not reach ' + this.label + ': ' + error.message };
    }
    // Only a success is cached: set up Windows Hello and it works without a restart.
    if (result.available) this.availability = result;
    return result;
  }

  /** Ask the person to verify. Resolves true only on success. */
  async verify(reason) {
    if (this.testAnswer) return this.testAnswer === 'approve';
    const text = String(reason || 'Static wants to make sure it is you').slice(0, 200);
    if (process.platform === 'darwin') {
      const { systemPreferences } = require('electron');
      try { await systemPreferences.promptTouchID(text.charAt(0).toLowerCase() + text.slice(1)); return true; }
      catch { return false; }
    }
    if (process.platform === 'win32') {
      const win = this.getWindow();
      let hwnd = '0';
      try {
        const handle = win?.getNativeWindowHandle?.();
        if (handle) hwnd = (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
      } catch { /* no parent: the prompt still opens, maybe behind */ }
      const answer = await this.#helper(['verify', hwnd, Buffer.from(text, 'utf8').toString('base64')], 120_000).catch(() => 'Error');
      return answer === 'Verified';
    }
    return false;
  }

  /** Run the Windows helper, compiling it first if this version has not been. */
  async #helper(args, timeout = 15_000) {
    const exe = await this.#compiled();
    return new Promise((resolve, reject) => {
      execFile(exe, args, { timeout, windowsHide: true }, (error, stdout) => {
        const out = String(stdout || '').trim().split(/\r?\n/).pop() || '';
        if (error && !out) return reject(error);
        resolve(out);
      });
    });
  }

  #compiled() {
    if (this.compiling) return this.compiling;
    const hash = crypto.createHash('sha256').update(SOURCE).digest('hex').slice(0, 12);
    const exe = path.join(this.binDir, 'static-hello-' + hash + '.exe');
    if (fs.existsSync(exe)) return Promise.resolve(exe);
    // Windows always sets SystemRoot; without it there is nothing to compile with.
    const windows = process.env.SystemRoot || process.env.windir || '';
    const framework = windows && [path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319'), path.join(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319')]
      .find((dir) => fs.existsSync(path.join(dir, 'csc.exe')));
    const meta = path.join(windows, 'System32', 'WinMetadata');
    this.compiling = new Promise((resolve, reject) => {
      if (!framework) return reject(new Error('the .NET Framework compiler is missing'));
      fs.mkdirSync(this.binDir, { recursive: true });
      const source = path.join(this.binDir, 'static-hello-' + hash + '.cs');
      fs.writeFileSync(source, SOURCE);
      execFile(path.join(framework, 'csc.exe'), [
        '-nologo', '-optimize', '-target:exe', '-out:' + exe,
        '-r:' + path.join(meta, 'Windows.Foundation.winmd'),
        '-r:' + path.join(meta, 'Windows.Security.winmd'),
        '-r:' + path.join(framework, 'System.Runtime.dll'),
        source,
      ], { timeout: 60_000, windowsHide: true }, (error, stdout) => {
        try { fs.rmSync(source, { force: true }); } catch { /* best effort */ }
        if (error || !fs.existsSync(exe)) return reject(new Error(String(stdout || error?.message || 'compile failed').trim().split(/\r?\n/)[0]));
        resolve(exe);
      });
    }).finally(() => { this.compiling = null; });
    return this.compiling;
  }
}

module.exports = { Biometric };
