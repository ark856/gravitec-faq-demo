<?php
/**
 * Plugin Name: Gravi-Tec AI Helper Widget
 * Description: Floating support chat popup for Gravi-Tec website. Adds a chat button
 *              in the bottom-right corner that opens the Gravi-Tec AI chat assistant.
 * Version:     0.8
 * Author:      Linovy UG
 * Text Domain: gravi-tec-ai-helper-widget
 */

// Prevent direct access
if (!defined('ABSPATH')) {
    exit;
}

define('GTW_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('GTW_PLUGIN_URL', plugin_dir_url(__FILE__));

// ============================================================
//  ENQUEUE ASSETS
// ============================================================

add_action('wp_enqueue_scripts', 'gtw_enqueue_assets');
function gtw_enqueue_assets() {
    wp_enqueue_style(
        'gravitec-chat',
        GTW_PLUGIN_URL . 'assets/gravitec-chat.css',
        array(),
        '1.0.1'
    );

    wp_enqueue_script(
        'gravitec-chat',
        GTW_PLUGIN_URL . 'assets/gravitec-chat.js',
        array(),
        '1.0.1',
        true
    );

    wp_localize_script('gravitec-chat', 'GT_WIDGET', array(
        'popupMode' => true,
    ));
}

// ============================================================
//  OUTPUT CHAT HTML IN FOOTER
// ============================================================

add_action('wp_footer', 'gtw_output_chat_markup');
function gtw_output_chat_markup() {
    $file = GTW_PLUGIN_DIR . 'gravitec-chat.html';
    if (!file_exists($file)) {
        return;
    }

    $html = file_get_contents($file);

    // Remove the local CSS link (already enqueued)
    $html = preg_replace('/<link\b[^>]*gravitec-chat\.css[^>]*>/i', '', $html);

    // Remove the local JS script tag (already enqueued)
    $html = preg_replace('/<script\b[^>]*gravitec-chat\.js[^>]*>[\s\S]*?<\/script>/i', '', $html);

    echo '<script>POPUP_MODE = true;</script>';
	echo '<script>window.GT_WIDGET = { popupMode: true };</script>';
    echo $html;
}

