use strict;
use warnings;
use HTTP::Daemon;
use HTTP::Response;

my $d = HTTP::Daemon->new(LocalAddr => '127.0.0.1', LocalPort => 8765, ReuseAddr => 1)
    or die "Cannot start: $!";
print "READY\n";

my %mime = (
    html => 'text/html; charset=utf-8', css => 'text/css; charset=utf-8',
    js => 'application/javascript; charset=utf-8', png => 'image/png',
    jpg => 'image/jpeg', jpeg => 'image/jpeg', svg => 'image/svg+xml',
    ico => 'image/x-icon', woff => 'font/woff', woff2 => 'font/woff2',
    mp4 => 'video/mp4', pdf => 'application/pdf'
);

my %mock_for = (
    '__mock_projects.html'  => 'projects.html',
    '__mock_community.html' => 'Community.html',
    '__mock_shared.html'    => 'Shared.html',
    '__mock_welcome.html'   => 'Welcome.html',
    '__mock_index.html'     => 'index.html'
);

sub slurp {
    my ($p) = @_;
    open(my $f, '<:raw', $p) or return undef;
    local $/;
    my $c = <$f>;
    close $f;
    return $c;
}

sub send_body {
    my ($c, $status, $type, $body) = @_;
    my $r = HTTP::Response->new($status);
    $r->header('Content-Type' => $type);
    $r->header('Content-Length' => length($body));
    $r->header('Connection' => 'close');
    $r->content($body);
    eval { $c->send_response($r) };
}

while (my $c = $d->accept) {
    my $req = $c->get_request;
    if (!$req) { $c->close; next; }

    my $path = $req->uri->path;
    $path =~ s{^/}{};
    $path = 'index.html' if $path eq '';

    if (exists $mock_for{$path}) {
        my $file = $mock_for{$path};
        my $html = slurp($file);
        if (defined $html) {
            $html =~ s{<script src="auth\.js"></script>}{<script src="__mock_supabase.js"></script><script src="auth.js"></script>};
            send_body($c, 200, $mime{html}, $html);
        } else {
            send_body($c, 404, 'text/plain', "missing $file");
        }
        $c->close;
        next;
    }

    if ($path =~ /\.\./ || $path =~ m{^[/\\]}) {
        send_body($c, 403, 'text/plain', 'forbidden');
        $c->close;
        next;
    }

    my $body = slurp($path);
    if (!defined $body) {
        send_body($c, 404, 'text/plain', 'not found');
        $c->close;
        next;
    }

    my ($ext) = $path =~ /\.([A-Za-z0-9]+)$/;
    send_body($c, 200, $mime{lc($ext || '')} || 'application/octet-stream', $body);
    $c->close;
}
