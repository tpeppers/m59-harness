// m59-tsrelay: publish loopback ports on your tailnet, with no Tailscale install.
//
//	go build -o m59-tsrelay.exe .      (once; see tools/m59-gate.mjs for the whole setup)
//	m59-tsrelay -forward 8950          (first run prints a login URL; open it once)
//
// WHY THIS AND NOT THE TAILSCALE CLIENT. tailscaled on Windows insists on a control pipe
// owned by Administrators ("This security ID may not be assigned as the owner of this
// object"), so it cannot run as an ordinary user even in userspace-networking mode, and
// the MSI wants elevation and a reboot-capable driver. tsnet is the same WireGuard and the
// same tailnet as a library: this process IS the node, it needs no admin, no service, no
// adapter, and it dies when you close it.
//
// It forwards tailnet:<port> to 127.0.0.1:<port> and nothing else. Anything it forwards is
// reachable by every device on your tailnet, so forward the gate (which checks keys) and
// not the broker (which checks nothing).
package main

import (
	"context"
	"flag"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"tailscale.com/tsnet"
)

func main() {
	hostname := flag.String("hostname", "m59-fleet", "this node's name on the tailnet")
	forward := flag.String("forward", "8950", "comma list: PORT or PORT=LOCALPORT")
	dir := flag.String("dir", "", "state directory (default: next to the executable)")
	verbose := flag.Bool("v", false, "tailscale's own logs")
	flag.Parse()

	if *dir == "" {
		exe, _ := os.Executable()
		*dir = filepath.Join(filepath.Dir(exe), "tsrelay-state")
	}
	s := &tsnet.Server{Hostname: *hostname, Dir: *dir, UserLogf: log.Printf}
	if !*verbose {
		s.Logf = func(string, ...any) {}
	}
	defer s.Close()

	st, err := s.Up(context.Background())
	if err != nil {
		log.Fatalf("tailnet up: %v", err)
	}
	for _, ip := range st.TailscaleIPs {
		log.Printf("on the tailnet as %s (%s)", *hostname, ip)
	}

	var wg sync.WaitGroup
	for _, spec := range strings.Split(*forward, ",") {
		spec = strings.TrimSpace(spec)
		if spec == "" {
			continue
		}
		pub, local, ok := strings.Cut(spec, "=")
		if !ok {
			local = pub
		}
		ln, err := s.Listen("tcp", ":"+pub)
		if err != nil {
			log.Fatalf("listen tailnet :%s: %v", pub, err)
		}
		log.Printf("tailnet :%s -> 127.0.0.1:%s", pub, local)
		wg.Add(1)
		go func(ln net.Listener, local string) {
			defer wg.Done()
			for {
				c, err := ln.Accept()
				if err != nil {
					log.Printf("accept: %v", err)
					return
				}
				go pipe(c, "127.0.0.1:"+local)
			}
		}(ln, local)
	}
	wg.Wait()
}

func pipe(c net.Conn, to string) {
	defer c.Close()
	d, err := net.Dial("tcp", to)
	if err != nil {
		log.Printf("%s -> %s: %v", c.RemoteAddr(), to, err)
		return
	}
	defer d.Close()
	log.Printf("%s -> %s", c.RemoteAddr(), to)
	done := make(chan struct{}, 2)
	go func() { io.Copy(d, c); done <- struct{}{} }()
	go func() { io.Copy(c, d); done <- struct{}{} }()
	<-done
}
